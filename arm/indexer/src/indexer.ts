import { getAddress, parseEventLogs, type Address, type Log } from "viem";
import { client, ADDR, ALL_FACTORIES, ALL_LOCKERS, addrsFor, isFactory, isLocker } from "./chain.js";
import { config, isStockFactory, quoteByAddress } from "./config.js";
import { sql, getSync, setSync } from "./db.js";
import { factoryAbi, hubAbi, lockerAbi, poolAbi, splitterAbi, stockFactoryAbi, stockLockerAbi, tokenAbi, treasuryAbi } from "./abi.js";
import { mcapFromSqrtPriceX96, priceUsdFromMcap6 } from "./price.js";
import { bus } from "./bus.js";
import { attachLaunch } from "./hotspots/service.js";
import { quotePriceAt, quoteToUsdc } from "./quotes.js";

/** quote = '' → USDC pool (every earlier generation); otherwise the stock the pool is quoted in. */
type TokenRow = { address: string; pool: string; is_token0: boolean; deployer: string; payout: string; factory: string | null; quote: string; quote_decimals: number; splitter: string | null };

const TRANSFER_EVENT = tokenAbi.find((x) => x.type === "event" && x.name === "Transfer")!;

const tokens = new Map<string, TokenRow>(); // lowercase address → row
const poolToToken = new Map<string, string>(); // lowercase pool → token
const blockTs = new Map<bigint, Date>();

async function loadKnown() {
  const rows = await sql<TokenRow[]>`select address, pool, is_token0, deployer, payout, factory, quote, quote_decimals, nullif(splitter, '') as splitter from tokens`;
  for (const r of rows) {
    tokens.set(r.address.toLowerCase(), r);
    poolToToken.set(r.pool.toLowerCase(), r.address);
  }
}

async function tsOf(block: bigint): Promise<Date> {
  const hit = blockTs.get(block);
  if (hit) return hit;
  const b = await client.getBlock({ blockNumber: block });
  const d = new Date(Number(b.timestamp) * 1000);
  blockTs.set(block, d);
  if (blockTs.size > 5000) blockTs.delete(blockTs.keys().next().value!);
  return d;
}

// ------------------------------------------------------------------ handlers

async function onTokenLaunched(log: Log, args: {
  token: Address; deployer: Address; pool: Address; positionId: bigint; isToken0: boolean;
  restrictionsEndBlock: bigint; graduationThreshold: bigint; initialBuyUsdc: bigint; creationFeePaid: bigint;
}) {
  const token = getAddress(args.token);
  if (tokens.has(token.toLowerCase())) return;
  const factory = getAddress(log.address); // which generation launched it → its locker / router
  const stock = isStockFactory(factory);
  const locker = addrsFor(factory).locker;
  const [name, symbol, logo, description, socials, tax] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: token, abi: tokenAbi, functionName: "name" },
      { address: token, abi: tokenAbi, functionName: "symbol" },
      { address: token, abi: tokenAbi, functionName: "logo" },
      { address: token, abi: tokenAbi, functionName: "description" },
      { address: token, abi: tokenAbi, functionName: "socials" },
      // tax mode: immutable on the token
      { address: token, abi: tokenAbi, functionName: "taxConfig" },
    ],
  });
  // the creator may pick a separate fee wallet at launch; the locker is the source of truth for payout. The stock
  // locker's `locks` has more fields (quote pool etc.), so each generation is read with its own ABI.
  let payoutRaw: string;
  let quote = "", quoteSymbol = "USDC", quoteDecimals = 6, quoteFee = 0, quotePool = "", quotePriceLaunch = 1_000_000n;
  if (stock) {
    const [lock, lq] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: locker, abi: stockLockerAbi, functionName: "locks", args: [token] },
        { address: factory, abi: stockFactoryAbi, functionName: "launchQuotes", args: [token] },
      ],
    });
    payoutRaw = lock[7];
    quote = getAddress(lq[0]);
    quoteFee = Number(lq[1]);
    quoteDecimals = Number(lq[2]);
    quotePriceLaunch = lq[3];
    quotePool = getAddress(lock[5]);
    quoteSymbol = quoteByAddress(quote)?.symbol ?? (await client.readContract({ address: quote as Address, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"));
  } else {
    const lock = await client.readContract({ address: locker, abi: lockerAbi, functionName: "locks", args: [token] });
    payoutRaw = lock[5];
  }
  const [buyTax, sellTax, taxMarketing, taxTeam, taxMarketingBps] = tax;
  const ts = await tsOf(log.blockNumber!);
  // Arm: the lock pays the token's CreatorFeeSplitter; the creator wallet (what dashboards key on) lives in the splitter
  const splitter = await splitterFor(token, payoutRaw);
  const payout = splitter
    ? await splitterCreator(splitter)
    : payoutRaw !== "0x0000000000000000000000000000000000000000" ? getAddress(payoutRaw) : getAddress(args.deployer);
  const row: TokenRow = { address: token, pool: getAddress(args.pool), is_token0: args.isToken0, deployer: getAddress(args.deployer), payout, factory, quote, quote_decimals: quoteDecimals, splitter };
  await sql`insert into tokens (address, name, symbol, logo, description, website, twitter, telegram, discord, farcaster, deployer, payout, pool, position_id,
      is_token0, launch_block, launch_ts, launch_tx, restrictions_end_block, graduation_threshold, initial_buy_usdc, creation_fee_paid,
      buy_tax_bps, sell_tax_bps, tax_marketing_wallet, tax_team_wallet, tax_marketing_bps, factory,
      quote, quote_symbol, quote_decimals, quote_usdc_fee, quote_pool, quote_price_usdc_launch)
    values (${token}, ${name}, ${symbol}, ${String(logo).replace(/^https?:\/\/[^/]+\/(api\/uploads|brand)\//, "/$1/")}, ${description}, ${socials[0]}, ${socials[1]}, ${socials[2]}, ${socials[3]}, ${socials[4]}, ${row.deployer}, ${row.payout},
      ${row.pool}, ${args.positionId.toString()}, ${args.isToken0}, ${Number(log.blockNumber)}, ${ts}, ${log.transactionHash!},
      ${Number(args.restrictionsEndBlock)}, ${args.graduationThreshold.toString()}, ${args.initialBuyUsdc.toString()}, ${args.creationFeePaid.toString()},
      ${Number(buyTax)}, ${Number(sellTax)}, ${buyTax > 0 || sellTax > 0 ? getAddress(taxMarketing) : ""}, ${buyTax > 0 || sellTax > 0 ? getAddress(taxTeam) : ""}, ${Number(taxMarketingBps)}, ${factory},
      ${quote}, ${quoteSymbol}, ${quoteDecimals}, ${quoteFee}, ${quotePool}, ${quotePriceLaunch.toString()})
    on conflict (address) do nothing`;
  if (splitter) {
    const bps = await client.readContract({ address: splitter as Address, abi: splitterAbi, functionName: "referralBps" }).catch(() => 0);
    await sql`update tokens set splitter = ${splitter}, referral_bps = ${Number(bps)}, referral_settled_to = ${ts} where address = ${token}`;
  }
  tokens.set(token.toLowerCase(), row);
  poolToToken.set(row.pool.toLowerCase(), token);
  // hotspot launches: link the token to the wallet's open claim for this symbol
  attachLaunch(row.deployer, symbol, token, log.transactionHash!).catch((e) => console.warn("[hotspots] attach failed", (e as Error).message));
  bus.emit("ws", { type: "launch", data: { token, symbol, name, deployer: row.deployer, ts, quote: quoteSymbol } });
  console.log(`[launch] ${symbol} ${token} pool=${row.pool}${stock ? ` quote=${quoteSymbol}` : ""}`);
}

async function onSwap(log: Log, args: { sender: Address; recipient: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number }) {
  const token = poolToToken.get(log.address.toLowerCase());
  if (!token) return;
  const t = tokens.get(token.toLowerCase())!;
  const quoteDelta = t.is_token0 ? args.amount1 : args.amount0; // + = quote (USDC or stock) into pool = buy
  const tokDelta = t.is_token0 ? args.amount0 : args.amount1;
  const side = quoteDelta > 0n ? "buy" : "sell";
  const quoteAmt = quoteDelta < 0n ? -quoteDelta : quoteDelta;
  const toks = tokDelta < 0n ? -tokDelta : tokDelta;
  // mcap in the pool's own quote units (6dp USDC for the USDC generation, quote raw for stock pools) …
  const mcapQuote = mcapFromSqrtPriceX96(args.sqrtPriceX96, t.is_token0);
  // … converted to USD (6dp) for everything the site shows. Stock pools: at the quote's USDC price near this block.
  let usdc = quoteAmt, mcap6 = mcapQuote, quotePx: bigint | null = null;
  if (t.quote) {
    quotePx = await quotePriceAt(t.quote, chunkEndBlock ?? log.blockNumber!);
    usdc = quoteToUsdc(quoteAmt, t.quote_decimals, quotePx);
    mcap6 = quoteToUsdc(mcapQuote, t.quote_decimals, quotePx);
  }
  const price = priceUsdFromMcap6(mcap6);
  const ts = await tsOf(log.blockNumber!);
  // Arm referral attribution: the router pays `recipient` (the trader's own wallet); router / aggregator hops fall back
  // to the tx sender. The referrer is whoever that wallet was bound to at trade time (first-touch, never changes).
  const trader = await traderOf(log, getAddress(args.recipient));
  const [bind] = await sql<{ referrer: string }[]>`select referrer from referral_bindings where wallet = ${trader.toLowerCase()} and bound_at <= ${ts}`;
  const referrer = bind?.referrer ?? null;

  const inserted = await sql`insert into trades (token, pool, tx_hash, log_index, block_number, ts, side, usdc, tokens, price, mcap6, sender, recipient, quote_amount, quote_price_usdc, trader, referrer)
    values (${token}, ${getAddress(log.address)}, ${log.transactionHash!}, ${log.logIndex!}, ${Number(log.blockNumber)}, ${ts}, ${side},
      ${usdc.toString()}, ${toks.toString()}, ${price}, ${mcap6.toString()}, ${getAddress(args.sender)}, ${getAddress(args.recipient)},
      ${t.quote ? quoteAmt.toString() : null}, ${quotePx?.toString() ?? null}, ${trader.toLowerCase()}, ${referrer})
    on conflict (tx_hash, log_index) do nothing returning id`;
  if (inserted.length === 0) return;

  const bucket = new Date(Math.floor(ts.getTime() / 60_000) * 60_000);
  await sql`insert into candles (token, bucket_ts, open, high, low, close, volume_usdc, trades)
    values (${token}, ${bucket}, ${price}, ${price}, ${price}, ${price}, ${usdc.toString()}, 1)
    on conflict (token, bucket_ts) do update set
      high = greatest(candles.high, excluded.high),
      low = least(candles.low, excluded.low),
      close = excluded.close,
      volume_usdc = candles.volume_usdc + excluded.volume_usdc,
      trades = candles.trades + 1`;
  await sql`update tokens set last_price = ${price}, last_mcap6 = ${mcap6.toString()},
      volume_since_distribute = volume_since_distribute + ${usdc.toString()}, updated_at = now() where address = ${token}`;

  bus.emit("ws", { type: "trade", data: { token, side, usdc: usdc.toString(), tokens: toks.toString(), price, mcap6: mcap6.toString(), wallet: getAddress(args.recipient), tx: log.transactionHash, ts, quoteAmount: t.quote ? quoteAmt.toString() : undefined } });
}

/** End block of the chunk being processed — stock trades convert at the quote price read once per chunk. */
let chunkEndBlock: bigint | undefined;

async function onTransfer(log: Log, args: { from: Address; to: Address; value: bigint }) {
  const token = tokens.get(log.address.toLowerCase());
  if (!token || args.value === 0n) return;
  const v = args.value.toString();
  const zero = "0x0000000000000000000000000000000000000000";
  if (args.from.toLowerCase() !== zero) {
    await sql`insert into holders (token, address, balance) values (${token.address}, ${getAddress(args.from)}, ${"-" + v})
      on conflict (token, address) do update set balance = holders.balance + excluded.balance`;
  }
  if (args.to.toLowerCase() !== zero) {
    await sql`insert into holders (token, address, balance) values (${token.address}, ${getAddress(args.to)}, ${v})
      on conflict (token, address) do update set balance = holders.balance + excluded.balance`;
  }
}

async function onFees(log: Log, args: { token: Address; quoteToCreator: bigint; quoteToProtocol: bigint; tokenConverted: bigint; usdcFromToken: bigint; creatorPaid: boolean }) {
  const token = getAddress(args.token);
  const t = tokens.get(token.toLowerCase());
  const ts = await tsOf(log.blockNumber!);
  // quote_* already include the USDC obtained by selling the token-side fees (payouts are USDC-only)
  const ins = await sql`insert into fee_events (token, tx_hash, log_index, block_number, ts, quote_creator, quote_protocol, token_converted, usdc_from_token, creator_paid, payout)
    values (${token}, ${log.transactionHash!}, ${log.logIndex!}, ${Number(log.blockNumber)}, ${ts}, ${args.quoteToCreator.toString()}, ${args.quoteToProtocol.toString()},
      ${args.tokenConverted.toString()}, ${args.usdcFromToken.toString()}, ${args.creatorPaid}, ${t?.payout ?? ""})
    on conflict (tx_hash, log_index, kind) do nothing returning id`;
  if (ins.length === 0) return;
  const total = args.quoteToCreator + args.quoteToProtocol;
  await sql`update tokens set fees_usdc_total = fees_usdc_total + ${total.toString()},
      fees_creator_usdc_total = fees_creator_usdc_total + ${args.quoteToCreator.toString()},
      last_distributed_at = ${ts}, volume_since_distribute = 0, updated_at = now() where address = ${token}`;
  bus.emit("ws", { type: "fees", data: { token, quoteToCreator: args.quoteToCreator.toString(), quoteToProtocol: args.quoteToProtocol.toString(), creatorPaid: args.creatorPaid, ts } });
}

/** Tax proceeds paid inside the same distribute() call to the token's two tax wallets → one payout row each. */
async function onTaxDistributed(log: Log, args: {
  token: Address; tokenConverted: bigint; marketingWallet: Address; usdcToMarketing: bigint; teamWallet: Address; usdcToTeam: bigint; allPaid: boolean;
}) {
  const token = getAddress(args.token);
  const ts = await tsOf(log.blockNumber!);
  const rows: [string, Address, bigint][] = [["tax_marketing", args.marketingWallet, args.usdcToMarketing], ["tax_team", args.teamWallet, args.usdcToTeam]];
  let inserted = 0n;
  for (const [kind, wallet, amt] of rows) {
    if (amt === 0n) continue;
    const ins = await sql`insert into fee_events (token, tx_hash, log_index, block_number, ts, quote_creator, quote_protocol, token_converted, usdc_from_token, creator_paid, payout, kind)
      values (${token}, ${log.transactionHash!}, ${log.logIndex!}, ${Number(log.blockNumber)}, ${ts}, ${amt.toString()}, 0,
        ${args.tokenConverted.toString()}, ${amt.toString()}, ${args.allPaid}, ${getAddress(wallet)}, ${kind})
      on conflict (tx_hash, log_index, kind) do nothing returning id`;
    if (ins.length) inserted += amt;
  }
  if (inserted === 0n) return;
  await sql`update tokens set tax_usdc_total = tax_usdc_total + ${inserted.toString()}, updated_at = now() where address = ${token}`;
  bus.emit("ws", { type: "fees", data: { token, kind: "tax", quoteToCreator: inserted.toString(), quoteToProtocol: "0", creatorPaid: args.allPaid, ts } });
}

async function onGraduated(log: Log, args: { token: Address; pairedUsdc: bigint; threshold: bigint }) {
  const token = getAddress(args.token);
  const ts = await tsOf(log.blockNumber!);
  await sql`update tokens set graduated = true, graduated_at = coalesce(graduated_at, ${ts}), paired_usdc = ${args.pairedUsdc.toString()} where address = ${token}`;
  bus.emit("ws", { type: "graduated", data: { token, pairedUsdc: args.pairedUsdc.toString(), ts } });
  console.log(`[graduated] ${token}`);
}

/** The wallet a swap belongs to: the pool's `recipient` unless that is a known contract (our router / locker / pool),
 *  in which case the transaction sender (cached per tx). */
const txFrom = new Map<string, string>();
async function traderOf(log: Log, recipient: string): Promise<string> {
  const lc = recipient.toLowerCase();
  const infra = [ADDR.router, ...ALL_LOCKERS, ...ALL_FACTORIES].some((a) => a.toLowerCase() === lc) || poolToToken.has(lc);
  if (!infra) return recipient;
  const h = log.transactionHash!;
  let from = txFrom.get(h);
  if (!from) {
    from = getAddress((await client.getTransaction({ hash: h })).from);
    txFrom.set(h, from);
    if (txFrom.size > 5000) txFrom.clear();
  }
  return from;
}

/** Lock payout rotated: `exit` from the splitter (→ a plain wallet) or back into it (→ the splitter's creator). */
async function onPayoutChanged(args: { token: Address; newPayout: Address }) {
  const token = getAddress(args.token);
  const t = tokens.get(token.toLowerCase());
  const next = getAddress(args.newPayout);
  const viaSplitter = !!t?.splitter && t.splitter.toLowerCase() === next.toLowerCase();
  const wallet = viaSplitter ? await splitterCreator(next) : next;
  await sql`update tokens set payout = ${wallet}, splitter_active = ${viaSplitter} where address = ${token}`;
  if (t) t.payout = wallet;
}

/** The splitter the hub created for this token, if the lock pays it (Arm launches); null for plain wallets. */
async function splitterFor(token: Address, payoutRaw: string): Promise<string | null> {
  if (/^0x0+$/.test(ADDR.hub)) return null;
  const s = await client.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "splitterOf", args: [token] }).catch(() => null);
  return s && !/^0x0+$/.test(s) && s.toLowerCase() === payoutRaw.toLowerCase() ? getAddress(s) : null;
}

async function splitterCreator(splitter: string): Promise<string> {
  return getAddress(await client.readContract({ address: splitter as Address, abi: splitterAbi, functionName: "creator" }));
}

/** Weekly treasury settlement: 76% → eco multisig, 20% → buyback multisig, 4% → dev wallet. */
async function onExecuted(log: Log, args: { usdcToEco: bigint; usdcToBuyback: bigint; usdcToDev: bigint }) {
  const ts = await tsOf(log.blockNumber!);
  const ins = await sql`insert into settlements (tx_hash, block_number, ts, usdc_to_eco, usdc_to_buyback, usdc_to_dev)
    values (${log.transactionHash!}, ${Number(log.blockNumber)}, ${ts}, ${args.usdcToEco.toString()}, ${args.usdcToBuyback.toString()}, ${args.usdcToDev.toString()})
    on conflict (tx_hash) do nothing returning id`;
  if (ins.length === 0) return;
  bus.emit("ws", { type: "settlement", data: { tx: log.transactionHash, usdcToEco: args.usdcToEco.toString(), usdcToBuyback: args.usdcToBuyback.toString(), usdcToDev: args.usdcToDev.toString(), ts } });
  console.log(`[treasury] settled: eco ${args.usdcToEco} · buyback ${args.usdcToBuyback} · dev ${args.usdcToDev}`);
}

async function onClaimed(log: Log, args: { account: Address; asset: Address; amount: bigint }) {
  const ts = await tsOf(log.blockNumber!);
  await sql`insert into claims (account, asset, amount, tx_hash, ts) values (${getAddress(args.account)}, ${getAddress(args.asset)}, ${args.amount.toString()}, ${log.transactionHash!}, ${ts})
    on conflict do nothing`;
}

// ------------------------------------------------------------------ range processing

type Typed = { log: Log; kind: string; args: unknown };

async function processRange(from: bigint, to: bigint) {
  chunkEndBlock = to;
  // 1) protocol contracts (fixed addresses). Register launches first so their pools/tokens are known
  //    for the same range (the launch tx's own Swap has a lower logIndex than TokenLaunched).
  //    Every factory / locker generation is listened to (the stock generation shares the event signatures); the token
  //    row remembers which factory launched it.
  const protoLogs = await client.getLogs({ address: [...ALL_FACTORIES, ...ALL_LOCKERS, ADDR.treasury], fromBlock: from, toBlock: to });
  const fLogs = parseEventLogs({ abi: factoryAbi, logs: protoLogs.filter((l) => isFactory(l.address)), strict: false });
  const lLogs = parseEventLogs({ abi: lockerAbi, logs: protoLogs.filter((l) => isLocker(l.address)), strict: false });
  const tLogs = parseEventLogs({ abi: treasuryAbi, logs: protoLogs.filter((l) => l.address.toLowerCase() === ADDR.treasury.toLowerCase()), strict: false });
  for (const l of fLogs) if (l.eventName === "TokenLaunched") await onTokenLaunched(l, l.args as never);

  // 2) gather every other event and replay strictly in chain order so counters like
  //    volume_since_distribute are reset/accumulated exactly as they happened onchain.
  const all: Typed[] = [];
  for (const l of fLogs) if (l.eventName === "Graduated") all.push({ log: l, kind: "graduated", args: l.args });
  for (const l of tLogs) if (l.eventName === "Executed") all.push({ log: l, kind: "executed", args: l.args });
  for (const l of lLogs) if (l.eventName === "FeesDistributed" || l.eventName === "TaxDistributed" || l.eventName === "PayoutChanged" || l.eventName === "Claimed") all.push({ log: l, kind: l.eventName, args: l.args });

  const pools = [...poolToToken.keys()] as Address[];
  const toks = [...tokens.keys()] as Address[];
  if (pools.length) {
    const swapLogs = await client.getLogs({ address: pools, event: poolAbi[0], fromBlock: from, toBlock: to });
    for (const l of swapLogs) all.push({ log: l, kind: "swap", args: l.args });
  }
  if (toks.length) {
    const xfer = await client.getLogs({ address: toks, event: TRANSFER_EVENT, fromBlock: from, toBlock: to });
    for (const l of xfer) all.push({ log: l, kind: "transfer", args: l.args });
  }
  all.sort((a, b) => (a.log.blockNumber === b.log.blockNumber ? Number(a.log.logIndex! - b.log.logIndex!) : Number(a.log.blockNumber! - b.log.blockNumber!)));

  for (const { log, kind, args } of all) {
    switch (kind) {
      case "swap": await onSwap(log, args as never); break;
      case "transfer": await onTransfer(log, args as never); break;
      case "FeesDistributed": await onFees(log, args as never); break;
      case "TaxDistributed": await onTaxDistributed(log, args as never); break;
      case "graduated": await onGraduated(log, args as never); break;
      case "executed": await onExecuted(log, args as never); break;
      case "PayoutChanged": await onPayoutChanged(args as never); break;
      case "Claimed": await onClaimed(log, args as never); break;
    }
  }
}

// ------------------------------------------------------------------ periodic on-chain refresh

export async function refreshOnchain() {
  const rows = await sql<{ address: string; graduated: boolean; factory: string | null }[]>`select address, graduated, factory from tokens`;
  if (rows.length === 0) return;
  const res = await client.multicall({
    allowFailure: true,
    contracts: rows.map((r) => ({ address: addrsFor(r.factory).factory, abi: factoryAbi, functionName: "graduationStatus" as const, args: [r.address as Address] })),
  });
  for (let i = 0; i < rows.length; i++) {
    const r = res[i];
    if (r.status !== "success") continue;
    const [paired, , graduated] = r.result as readonly [bigint, bigint, boolean];
    await sql`update tokens set paired_usdc = ${paired.toString()}, graduated = tokens.graduated or ${graduated} where address = ${rows[i].address}`;
  }
}

// ------------------------------------------------------------------ main loop

export async function startIndexer() {
  await loadKnown();
  let next = BigInt((await getSync("last_block")) ?? (config.startBlock - 1n).toString()) + 1n;
  console.log(`[indexer] ${tokens.size} tokens known, resuming from block ${next}`);

  for (;;) {
    try {
      const head = await client.getBlockNumber();
      while (next <= head) {
        const to = next + config.chunkSize - 1n > head ? head : next + config.chunkSize - 1n;
        await processRange(next, to);
        await setSync("last_block", to.toString());
        if (to - next > 50n) console.log(`[indexer] synced ${next}..${to} (head ${head})`);
        next = to + 1n;
      }
    } catch (e) {
      console.error("[indexer] error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}
