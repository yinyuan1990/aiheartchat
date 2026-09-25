import { decodeEventLog, getAddress, isAddress, maxUint256, parseAbi, type Address } from "viem";
import { client, keeperWallet, ADDR, addrsFor } from "./chain.js";
import { config } from "./config.js";
import { sql, getSync, setSync } from "./db.js";
import { quoterAbi } from "./abi.js";
import { getSettings } from "./hotspots/settings.js";
import { keeperLog } from "./keeper-log.js";

/**
 * Automatic buyback & burn (boss 9.18): the project tops up the keeper wallet with USDC; on a schedule the wallet buys
 * the configured token on its Uniswap V3 pool with the swap recipient set to the dead address, so the bought tokens
 * are burned in the same transaction. Every run is recorded in `manual_burns` (note "auto") next to the hand-entered
 * burns, so /admin shows one burn history. Interval / amount / token / gas reserve live in the owner-signed settings
 * row; `enabled` off = the loop idles. Arc pays gas in USDC from the very same balance, hence the reserve.
 */

const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
const TICK_MS = 30_000;
const KEY_LAST = "bb_last_run";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const tokenTransfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

type LogEntry = { ts: string; ok: boolean; detail: string; hash?: string };
const log: LogEntry[] = [];
let lastError: string | null = null;
let running = false;
function note(e: Omit<LogEntry, "ts">) {
  log.unshift({ ts: new Date().toISOString(), ...e });
  if (log.length > 100) log.length = 100;
  if (!e.ok) lastError = e.detail;
  keeperLog({ action: "buyback", detail: e.detail, hash: e.hash, ok: e.ok });
}

export const buybackEnabledOnServer = config.keeper.enabled && !!config.keeper.privateKey;

export async function buybackStatus() {
  const s = await getSettings();
  const last = Number((await getSync(KEY_LAST)) ?? "0");
  let wallet: string | null = null;
  let balance: string | null = null;
  if (buybackEnabledOnServer) {
    const { account } = keeperWallet();
    wallet = account.address;
    balance = (await client.readContract({ address: ADDR.usdc, abi: erc20, functionName: "balanceOf", args: [account.address] }).catch(() => null))?.toString() ?? null;
  }
  return {
    available: buybackEnabledOnServer,
    wallet,
    balanceUsdc: balance,
    enabled: s.bbEnabled,
    token: s.bbToken,
    intervalMin: s.bbIntervalMin,
    amountUsd: s.bbAmountUsd,
    reserveUsd: s.bbReserveUsd,
    slippageBps: s.bbSlippageBps,
    lastRun: last ? new Date(last).toISOString() : null,
    nextRun: s.bbEnabled && s.bbToken ? new Date(Math.max(Date.now(), last + s.bbIntervalMin * 60_000)).toISOString() : null,
    running,
    lastError,
    log: log.slice(0, 50),
  };
}

/** One buy → burn. `force` ignores the schedule (owner "run now"). Returns the record or a reason it was skipped. */
export async function runBuyback(force = false): Promise<{ ok: boolean; detail: string; hash?: string }> {
  if (!buybackEnabledOnServer) return { ok: false, detail: "keeper wallet not configured" };
  if (running) return { ok: false, detail: "already running" };
  const s = await getSettings();
  if (!force && !s.bbEnabled) return { ok: false, detail: "disabled" };
  if (!isAddress(s.bbToken)) return { ok: false, detail: "no token configured" };
  const last = Number((await getSync(KEY_LAST)) ?? "0");
  if (!force && Date.now() < last + s.bbIntervalMin * 60_000) return { ok: false, detail: "not due" };

  running = true;
  try {
    const token = getAddress(s.bbToken);
    const [row] = await sql<{ factory: string | null; symbol: string; buy_tax_bps: number }[]>`select factory, symbol, buy_tax_bps from tokens where address = ${token}`;
    if (!row) return fail("token is not an Arm launch");
    const A = addrsFor(row.factory);
    const { account, wallet } = keeperWallet();
    const amountIn = BigInt(Math.round(s.bbAmountUsd * 1e6));
    const reserve = BigInt(Math.round(s.bbReserveUsd * 1e6));
    if (amountIn <= 0n) return fail("amount is 0");

    const bal = await client.readContract({ address: ADDR.usdc, abi: erc20, functionName: "balanceOf", args: [account.address] });
    if (bal < amountIn + reserve) return fail(`insufficient USDC: have ${fmt(bal)}, need ${fmt(amountIn)} + ${fmt(reserve)} reserve`);

    // quote → minOut with slippage; the token's own buy tax (if any) is taken from the recipient's side, so account for it
    const { result } = await client.simulateContract({
      address: A.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: ADDR.usdc, tokenOut: token, amountIn, fee: 10_000, sqrtPriceLimitX96: 0n }],
    });
    const out = result[0];
    if (out === 0n) return fail("quote returned 0");
    const minOut = (out * BigInt(10_000 - s.bbSlippageBps)) / 10_000n;

    const allowance = await client.readContract({ address: ADDR.usdc, abi: erc20, functionName: "allowance", args: [account.address, A.router] });
    if (allowance < amountIn) {
      const h = await wallet.writeContract({ address: ADDR.usdc, abi: erc20, functionName: "approve", args: [A.router, maxUint256], chain: wallet.chain, account });
      await client.waitForTransactionReceipt({ hash: h });
    }

    // recipient = dead address: the swap output is burned in the same transaction
    const hash = await wallet.writeContract({
      address: A.router, abi: routerAbi, functionName: "exactInputSingle",
      args: [{ tokenIn: ADDR.usdc, tokenOut: token, fee: 10_000, recipient: DEAD, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      chain: wallet.chain, account,
    });
    const rc = await client.waitForTransactionReceipt({ hash });
    await setSync(KEY_LAST, String(Date.now()));
    if (rc.status !== "success") return fail(`swap reverted ${hash}`, hash);

    // what actually reached the dead address (net of buy tax)
    let burned = 0n;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== token.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: tokenTransfer, data: l.data, topics: l.topics });
        if ((ev.args as { to: Address }).to.toLowerCase() === DEAD.toLowerCase()) burned += (ev.args as { value: bigint }).value;
      } catch { /* not a Transfer */ }
    }
    const block = await client.getBlock({ blockNumber: rc.blockNumber });
    await sql`insert into manual_burns (tx_hash, block_number, ts, sender, token, token_symbol, tokens_burned, usdc_spent, note, added_by)
      values (${hash}, ${Number(rc.blockNumber)}, ${new Date(Number(block.timestamp) * 1000)}, ${account.address}, ${token}, ${row.symbol}, ${burned.toString()}, ${amountIn.toString()}, ${"auto"}, ${account.address})
      on conflict (tx_hash) do nothing`;
    const detail = `bought & burned ${(Number(burned) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${row.symbol} for ${fmt(amountIn)} USDC`;
    note({ ok: true, detail, hash });
    return { ok: true, detail, hash };
  } catch (e) {
    return fail((e as Error).message.split("\n")[0]);
  } finally {
    running = false;
  }

  function fail(detail: string, hash?: string) {
    note({ ok: false, detail, hash });
    return { ok: false, detail, hash };
  }
}

const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(2);

export async function startBuyback() {
  if (!buybackEnabledOnServer) return;
  console.log("[buyback] loop started");
  for (;;) {
    try {
      const r = await runBuyback(false);
      if (r.ok) console.log(`[buyback] ${r.detail} ${r.hash}`);
      else if (!["disabled", "not due", "no token configured", "already running"].includes(r.detail)) console.warn(`[buyback] ${r.detail}`);
    } catch (e) {
      console.error("[buyback] error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
