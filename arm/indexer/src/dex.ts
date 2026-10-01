import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { arc, client } from "./chain.js";
import { config, firstDeployBlock, isMainnet } from "./config.js";
import { getSync, setSync, sql } from "./db.js";

/**
 * Chain-wide DEX tape (10.1): every Uniswap V3 / V2 style Swap on Arc whose pool pairs a token with USDC, attributed to
 * the swap's recipient (routers on Arc pay the output straight to the trader). Feeds the wallet trading card and any
 * cross-token stats; Arm's own `trades` table stays the source for Arm launches.
 */

const SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as Hex;
const SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822" as Hex;
const USDC = "0x3600000000000000000000000000000000000000";
const WINDOW = 9_999n;
export const DEX_START = BigInt(process.env.DEX_START_BLOCK ?? (isMainnet ? 21_000_000 : firstDeployBlock));
// the keyless public RPC sustains ~2 getLogs/s and the main indexer shares it, so the backfill paces itself
const PACE_MS = Number(process.env.DEX_PACE_MS ?? 1500);
const IDLE_MS = 15_000;

const node = (url: string) => createPublicClient({ chain: arc, transport: http(url, { retryCount: 0, timeout: 60_000 }) });
type Rpc = ReturnType<typeof node>;
const rpc = node(config.rpcUrl);
// Backfill runs one worker per endpoint so the main indexer keeps the primary RPC to itself. Keyless archive nodes
// that serve 20 000-log getLogs as of 10.1 (PublicNode / Blockdaemon / dRPC refuse history on their free tiers).
const backfillRpcs = (process.env.DEX_BACKFILL_RPCS ?? "https://rpc.beamrpc.com,https://arc.gateway.tenderly.co,https://rpc.quicknode.mainnet.arc.io")
  .split(",").map((s) => s.trim()).filter(Boolean).map(node);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

type Pool = { address: string; token: string; tokenIs0: boolean; decimals: number; usdc: boolean };
const pools = new Map<string, Pool>();
let synced = 0n;
let head = 0n;

export function dexProgress() {
  const total = head > DEX_START ? Number(head - DEX_START) : 1;
  const done = synced > DEX_START ? Number(synced - DEX_START) : 0;
  return { ready: head > 0n && synced >= head - 2n * WINDOW, progress: Math.min(1, done / total), synced: Number(synced) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const word = (data: Hex, i: number) => BigInt(`0x${data.slice(2 + i * 64, 66 + i * 64)}`);
const int = (v: bigint) => BigInt.asIntN(256, v);

type RawLog = { address: string; topics: Hex[]; data: Hex; transactionHash: string; logIndex: string; blockNumber: string };

/**
 * Busy windows exceed the node's 20 000-result cap; its error names a range that fits ("retry with the range a-b"), so
 * fetch that and continue after it. Rate limits back off; anything else halves the range.
 */
async function getLogs(from: bigint, to: bigint, via: Rpc = rpc): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let start = from, attempt = 0;
  while (start <= to) {
    try {
      out.push(...((await via.request({ method: "eth_getLogs", params: [{ fromBlock: hex(start), toBlock: hex(to), topics: [[SWAP_V3, SWAP_V2]] }] } as never)) as RawLog[]));
      return out;
    } catch (e) {
      const msg = `${(e as Error).message ?? ""} ${(e as { details?: string }).details ?? ""}`;
      const fit = /retry with the range (\d+)-(\d+)/.exec(msg);
      if (fit && BigInt(fit[2]) >= start && BigInt(fit[2]) < to) {
        out.push(...(await getLogs(start, BigInt(fit[2]), via)));
        start = BigInt(fit[2]) + 1n;
        attempt = 0;
        continue;
      }
      if (!/rate limit|429|too many requests/i.test(msg) && to > start) {
        const mid = (start + to) / 2n;
        out.push(...(await getLogs(start, mid, via)));
        start = mid + 1n;
        continue;
      }
      if (++attempt > 6) throw e;
      await sleep(1500 * 2 ** Math.min(attempt, 4));
    }
  }
  return out;
}

/** Read token0/token1 (+ the token's decimals) of pools seen for the first time; non-USDC pairs are kept as ignored. */
async function discover(addrs: string[]) {
  const fresh = addrs.filter((a) => !pools.has(a));
  if (!fresh.length) return;
  const r = await client.multicall({
    allowFailure: true,
    contracts: fresh.flatMap((a) => [
      { address: a as Address, abi: pairAbi, functionName: "token0" },
      { address: a as Address, abi: pairAbi, functionName: "token1" },
      { address: a as Address, abi: pairAbi, functionName: "factory" },
    ]),
  });
  const found = fresh.map((a, i) => {
    const [t0, t1, f] = r.slice(i * 3, i * 3 + 3);
    const a0 = t0.status === "success" ? String(t0.result).toLowerCase() : "";
    const a1 = t1.status === "success" ? String(t1.result).toLowerCase() : "";
    const tokenIs0 = a1 === USDC && a0 !== USDC;
    const usdc = !!a0 && !!a1 && (tokenIs0 || (a0 === USDC && a1 !== USDC));
    return { address: a, token: usdc ? (tokenIs0 ? a0 : a1) : "", tokenIs0, usdc, factory: f.status === "success" ? String(f.result).toLowerCase() : "" };
  });
  const tokens = [...new Set(found.filter((p) => p.usdc).map((p) => p.token))];
  const m = tokens.length
    ? await client.multicall({ allowFailure: true, contracts: tokens.flatMap((t) => [
        { address: t as Address, abi: erc20, functionName: "symbol" },
        { address: t as Address, abi: erc20, functionName: "decimals" },
      ]) })
    : [];
  const meta = new Map(tokens.map((t, i) => [t, {
    symbol: m[i * 2]?.status === "success" ? String(m[i * 2].result).slice(0, 24) : "?",
    decimals: m[i * 2 + 1]?.status === "success" ? Number(m[i * 2 + 1].result) : 18,
  }]));
  for (const p of found) {
    const md = meta.get(p.token) ?? { symbol: "", decimals: 18 };
    pools.set(p.address, { address: p.address, token: p.token, tokenIs0: p.tokenIs0, decimals: md.decimals, usdc: p.usdc });
    await sql`insert into dex_pools (address, token, token_is0, symbol, decimals, factory, usdc)
              values (${p.address}, ${p.token}, ${p.tokenIs0}, ${md.symbol}, ${md.decimals}, ${p.factory}, ${p.usdc})
              on conflict (address) do nothing`;
  }
}

type SwapRow = { block: string; log_index: number; tx: string; pool: string; trader: string; side: number; qty: string; usdc: string };

function parse(l: RawLog, p: Pool): { row: SwapRow | null; px: number } {
  const trader = `0x${l.topics[2].slice(26)}`.toLowerCase();
  let qty = 0n, usdc = 0n, side = 0, px = 0;
  const scale = 10 ** (p.decimals - 6);
  if (l.topics[0] === SWAP_V3) {
    const a0 = int(word(l.data, 0)), a1 = int(word(l.data, 1));
    const [tok, usd] = p.tokenIs0 ? [a0, a1] : [a1, a0];
    if (tok < 0n && usd > 0n) { side = 1; qty = -tok; usdc = usd; }
    else if (tok > 0n && usd < 0n) { side = -1; qty = tok; usdc = -usd; }
    const r = Number(word(l.data, 2)) / 2 ** 96;
    const raw = r * r; // token1 raw per token0 raw
    px = p.tokenIs0 ? raw * scale : raw > 0 ? scale / raw : 0;
  } else {
    const [i0, i1, o0, o1] = [0, 1, 2, 3].map((i) => word(l.data, i));
    const [tIn, tOut, uIn, uOut] = p.tokenIs0 ? [i0, o0, i1, o1] : [i1, o1, i0, o0];
    if (tOut > 0n && uIn > 0n) { side = 1; qty = tOut; usdc = uIn; }
    else if (tIn > 0n && uOut > 0n) { side = -1; qty = tIn; usdc = uOut; }
    if (qty > 0n) px = (Number(usdc) / 1e6) / (Number(qty) / 10 ** p.decimals);
  }
  const row = side ? { block: BigInt(l.blockNumber).toString(), log_index: Number(BigInt(l.logIndex)), tx: l.transactionHash, pool: p.address, trader, side, qty: qty.toString(), usdc: usdc.toString() } : null;
  return { row, px: Number.isFinite(px) ? px : 0 };
}

async function syncWindow(from: bigint, to: bigint, via: Rpc = rpc) {
  const logs = (await getLogs(from, to, via)).filter((l) => l.topics.length === 3);
  await discover([...new Set(logs.map((l) => l.address.toLowerCase()))]);
  const rows: SwapRow[] = [];
  const last = new Map<string, { px: number; block: bigint }>();
  for (const l of logs) {
    const p = pools.get(l.address.toLowerCase());
    if (!p?.usdc) continue;
    const { row, px } = parse(l, p);
    if (row) rows.push(row);
    if (px > 0) last.set(p.address, { px, block: BigInt(l.blockNumber) });
  }
  for (let i = 0; i < rows.length; i += 2000) await sql`insert into dex_swaps ${sql(rows.slice(i, i + 2000))} on conflict do nothing`;
  for (const [a, v] of last) await sql`update dex_pools set last_px = ${v.px}, last_block = ${v.block.toString()} where address = ${a} and coalesce(last_block, 0) <= ${v.block.toString()}`;
}

/**
 * Catch up to the head with a few windows in flight (the node serves ~800 logs/s per request, ~2× that with three in
 * parallel). `synced` only advances over a contiguous run of finished windows, so a restart redoes at most the
 * in-flight ones (swaps are keyed by block + log index).
 */
async function backfill() {
  const workers = Number(process.env.DEX_BACKFILL_WORKERS ?? Math.max(1, backfillRpcs.length));
  for (;;) {
    try {
      head = await rpc.getBlockNumber();
    } catch {
      await sleep(10_000);
      continue;
    }
    if (synced >= head - 2n * WINDOW) return;
    const target = head;
    const windows: [bigint, bigint][] = [];
    for (let b = synced + 1n; b <= target; b += WINDOW + 1n) windows.push([b, b + WINDOW > target ? target : b + WINDOW]);
    const done = new Set<number>();
    let next = 0, contiguous = 0;
    const nodes = backfillRpcs.length ? backfillRpcs : [rpc];
    const worker = async (k: number) => {
      while (next < windows.length) {
        const i = next++;
        // a node that keeps failing hands its window to the next one
        for (let n = k; ; n++) {
          try { await syncWindow(windows[i][0], windows[i][1], nodes[n % nodes.length]); break; } catch (e) {
            console.warn("[dex] window failed, retrying:", (e as Error).message.split("\n")[0]);
            await sleep(5_000);
          }
        }
        done.add(i);
        while (done.has(contiguous)) contiguous++;
        const reached = windows[contiguous - 1]?.[1];
        if (reached && reached > synced) { synced = reached; await setSync("dex_last_block", reached.toString()); }
        await sleep(PACE_MS);
      }
    };
    await Promise.all(Array.from({ length: workers }, (_, k) => worker(k)));
    console.log(`[dex] backfill reached ${synced}`);
  }
}

export async function startDexSync() {
  try {
    for (const r of await sql<{ address: string; token: string; token_is0: boolean; decimals: number; usdc: boolean }[]>`select address, token, token_is0, decimals, usdc from dex_pools`)
      pools.set(r.address, { address: r.address, token: r.token, tokenIs0: r.token_is0, decimals: r.decimals, usdc: r.usdc });
    synced = BigInt((await getSync("dex_last_block")) ?? (DEX_START - 1n).toString());
  } catch (e) {
    console.error("[dex] init failed:", (e as Error).message);
    return;
  }
  await backfill();
  for (;;) {
    try {
      head = await rpc.getBlockNumber();
      if (synced >= head) { await sleep(IDLE_MS); continue; }
      const from = synced + 1n, to = from + WINDOW > head ? head : from + WINDOW;
      await syncWindow(from, to);
      synced = to;
      await setSync("dex_last_block", to.toString());
      await sleep(to === head ? IDLE_MS : PACE_MS);
    } catch (e) {
      console.warn("[dex] sync failed:", (e as Error).message.split("\n")[0]);
      await sleep(10_000);
    }
  }
}
