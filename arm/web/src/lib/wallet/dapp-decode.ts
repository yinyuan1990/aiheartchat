import { decodeFunctionData, erc20Abi as viemErc20Abi, formatUnits, getAddress, hexToString, isAddress, isHex, parseAbi, type Abi, type Address, type Hex } from "viem";
import { ADDR, STOCK, factoryAbi, lockerAbi, routerAbi, stockFactoryAbi } from "@/lib/web3";
import { vaultAbi } from "@/lib/boat";
import { publicClientFor, type WalletChain } from "./chains";
import { t } from "./i18n";

/**
 * Turns DApp requests into something a person can judge. Only well-known calls get a summary; anything else is shown
 * raw with a warning — never guess (a wrong "human" summary is worse than none).
 */

export type Risk = "none" | "warn" | "danger";
export type Line = { label: string; value: string; mono?: boolean; tone?: "up" | "down" };
export type TxView = { title: string; lines: Line[]; risk: Risk; notes: string[]; contract?: string; known: boolean; fn?: string };

const MAX_HALF = 2n ** 255n;
const ARC_ID = 5042;
const BOAT = { vault: "0x595ae3F3c40fb4970a93D2BD3Af7DBf69a40c813" as Address, token: "0x6fceD62cdb01E141Bb0895eA9f519d8caE0160e9" as Address };

const extraAbi = parseAbi([
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);
const ABIS: Abi[] = [viemErc20Abi, extraAbi, routerAbi, factoryAbi, stockFactoryAbi, lockerAbi, vaultAbi];

function knownContracts(chainId: number): Record<string, string> {
  if (chainId !== ARC_ID) return {};
  const m: Record<string, string | undefined> = {
    [ADDR.factory]: t("cw.dapp.cArmFactory"),
    [ADDR.locker]: t("cw.dapp.cArmLocker"),
    [ADDR.router]: t("cw.dapp.cArmRouter"),
    [ADDR.quoter]: t("cw.dapp.cUniQuoter"),
    [ADDR.positionManager]: t("cw.dapp.cUniPositions"),
    [ADDR.treasury]: t("cw.dapp.cArmTreasury"),
    [BOAT.vault]: t("cw.dapp.cBoatVault"),
    [BOAT.token]: t("cw.dapp.cBoatToken"),
    [ADDR.usdc]: "USDC",
  };
  if (ADDR.referralHub) m[ADDR.referralHub] = t("cw.dapp.cArmReferral");
  if (STOCK) {
    m[STOCK.factory] = t("cw.dapp.cArmFactoryStock");
    m[STOCK.locker] = t("cw.dapp.cArmLockerStock");
  }
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([k, v]) => [k.toLowerCase(), v!]));
}
export const contractName = (chainId: number, a?: string | null) => (a ? knownContracts(chainId)[a.toLowerCase()] : undefined);
const isAt = (chainId: number, a: string, ...addrs: (string | undefined)[]) => chainId === ARC_ID && addrs.some((x) => x && x.toLowerCase() === a.toLowerCase());

type TokenMeta = { symbol: string; decimals: number };
const tokenCache = new Map<string, TokenMeta | null>();
async function tokenMeta(chain: WalletChain, a: Address): Promise<TokenMeta | null> {
  const key = `${chain.key}:${a.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key)!;
  const stable = chain.stables.find((s) => s.address.toLowerCase() === a.toLowerCase());
  let meta: TokenMeta | null = stable ? { symbol: stable.symbol, decimals: stable.decimals } : null;
  if (!meta) {
    try {
      const pc = publicClientFor(chain);
      const [symbol, decimals] = await Promise.all([
        pc.readContract({ address: a, abi: viemErc20Abi, functionName: "symbol" }),
        pc.readContract({ address: a, abi: viemErc20Abi, functionName: "decimals" }),
      ]);
      meta = { symbol: String(symbol).slice(0, 16), decimals: Number(decimals) };
    } catch {
      meta = null;
    }
  }
  tokenCache.set(key, meta);
  return meta;
}

const fmtNum = (s: string) => {
  const [i, d = ""] = s.split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const dec = d.slice(0, 6).replace(/0+$/, "");
  return dec ? `${int}.${dec}` : int;
};
async function amountOf(chain: WalletChain, token: Address, raw: bigint) {
  const m = await tokenMeta(chain, token);
  return m ? `${fmtNum(formatUnits(raw, m.decimals))} ${m.symbol}` : t("cw.dapp.rawAmount", { n: raw.toString(), token: short(token) });
}
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nameOr = (chainId: number, a: string) => contractName(chainId, a) ?? short(a);

export type TxRequest = { from?: Address; to?: Address; value?: bigint; data?: Hex };

export async function describeTx(chain: WalletChain, tx: TxRequest, trustedSite: boolean): Promise<TxView> {
  const id = chain.chain.id;
  const nc = chain.chain.nativeCurrency;
  const value = tx.value ?? 0n;
  const lines: Line[] = [];
  const notes: string[] = [];
  const to = tx.to ? getAddress(tx.to) : undefined;
  const cname = contractName(id, to);
  if (value > 0n) lines.push({ label: t("cw.dapp.pay"), value: `${fmtNum(formatUnits(value, nc.decimals))} ${nc.symbol}`, mono: true, tone: "down" });

  if (!to) return { title: t("cw.dapp.deployTitle"), lines, risk: "warn", notes: [t("cw.dapp.deployNote")], known: false };

  if (!tx.data || tx.data === "0x") {
    lines.push({ label: t("cw.dapp.recipient"), value: to, mono: true });
    return { title: t("cw.dapp.sendTitle", { sym: nc.symbol }), lines, risk: "none", notes, contract: cname, known: true };
  }

  type Decoded = { functionName: string; args?: readonly unknown[] };
  let decoded = null as Decoded | null;
  for (const abi of ABIS) {
    try {
      decoded = decodeFunctionData({ abi, data: tx.data }) as unknown as Decoded;
      break;
    } catch {}
  }

  const base = { contract: cname, fn: decoded?.functionName };
  if (!decoded) {
    lines.push({ label: t("cw.dapp.contract"), value: cname ?? to, mono: !cname });
    lines.push({ label: t("cw.dapp.method"), value: tx.data.slice(0, 10), mono: true });
    notes.push(cname ? t("cw.dapp.unparsedKnown") : t("cw.dapp.unparsedUnknown"));
    return { title: t("cw.dapp.callTitle"), lines, risk: cname || trustedSite ? "warn" : "danger", notes, known: false, ...base };
  }

  const a = (decoded.args ?? []) as unknown[];
  const f = decoded.functionName;
  const self = tx.from?.toLowerCase();

  if (f === "approve" || f === "increaseAllowance") {
    const spender = getAddress(a[0] as Address);
    const amt = a[1] as bigint;
    const meta = await tokenMeta(chain, to);
    const sym = meta?.symbol ?? short(to);
    const sname = contractName(id, spender);
    const unlimited = amt >= MAX_HALF;
    lines.push({ label: t("cw.dapp.token"), value: sym });
    lines.push({ label: t("cw.dapp.spender"), value: sname ?? spender, mono: !sname });
    lines.push({ label: t("cw.dapp.amount"), value: amt === 0n ? t("cw.dapp.revokeAmount") : unlimited ? t("cw.dapp.unlimited") : await amountOf(chain, to, amt), tone: unlimited ? "down" : undefined });
    if (amt === 0n) return { title: t("cw.dapp.revokeTitle", { sym }), lines, risk: "none", notes, known: true, ...base };
    let risk: Risk = "none";
    if (!sname) {
      risk = unlimited || !trustedSite ? "danger" : "warn";
      notes.push(unlimited ? t("cw.dapp.approveAllNote", { sym }) : t("cw.dapp.approveSomeNote", { sym }));
    } else if (unlimited) notes.push(t("cw.dapp.armApproveNote"));
    return { title: unlimited ? t("cw.dapp.approveUnlimitedTitle", { sym }) : t("cw.dapp.approveTitle", { sym }), lines, risk, notes, known: true, ...base };
  }

  if (f === "transfer" || f === "transferFrom") {
    const [src, dst, amt] = f === "transfer" ? [tx.from, a[0] as Address, a[1] as bigint] : [a[0] as Address, a[1] as Address, a[2] as bigint];
    lines.push({ label: t("cw.dapp.amount"), value: await amountOf(chain, to, amt), mono: true, tone: "down" });
    if (f === "transferFrom" && src && src.toLowerCase() !== self) lines.push({ label: t("cw.dapp.from"), value: src, mono: true });
    lines.push({ label: t("cw.dapp.recipient"), value: dst, mono: true });
    const meta = await tokenMeta(chain, to);
    if (!trustedSite) notes.push(t("cw.dapp.directSendNote"));
    return { title: meta?.symbol ? t("cw.dapp.sendTitle", { sym: meta.symbol }) : t("cw.dapp.sendTokenTitle"), lines, risk: trustedSite ? "none" : "warn", notes, known: true, ...base };
  }

  if (f === "setApprovalForAll") {
    const on = a[1] as boolean;
    const op = getAddress(a[0] as Address);
    lines.push({ label: t("cw.dapp.contract"), value: cname ?? to, mono: !cname });
    lines.push({ label: t("cw.dapp.spender"), value: nameOr(id, op), mono: true });
    if (!on) return { title: t("cw.dapp.revokeNftTitle"), lines, risk: "none", notes, known: true, ...base };
    notes.push(t("cw.dapp.nftNote"));
    return { title: t("cw.dapp.approveNftTitle"), lines, risk: "danger", notes, known: true, ...base };
  }

  if (f === "exactInputSingle") {
    const p = a[0] as { tokenIn: Address; tokenOut: Address; recipient: Address; amountIn: bigint; amountOutMinimum: bigint };
    lines.push({ label: t("cw.dapp.pay"), value: await amountOf(chain, p.tokenIn, p.amountIn), mono: true, tone: "down" });
    lines.push({ label: t("cw.dapp.minReceive"), value: await amountOf(chain, p.tokenOut, p.amountOutMinimum), mono: true, tone: "up" });
    lines.push({ label: t("cw.dapp.contract"), value: cname ?? to, mono: !cname });
    if (self && p.recipient.toLowerCase() !== self) notes.push(t("cw.dapp.otherRecipientNote", { addr: short(p.recipient) }));
    return { title: t("cw.dapp.swapTitle"), lines, risk: self && p.recipient.toLowerCase() !== self ? "danger" : cname ? "none" : "warn", notes, known: true, ...base };
  }

  if (f === "exactInput") {
    const p = a[0] as { path: Hex; recipient: Address; amountIn: bigint; amountOutMinimum: bigint };
    const hops = (p.path.length - 2) / 46; // 20-byte token + 3-byte fee per hop, hex chars
    const tokenIn = getAddress(`0x${p.path.slice(2, 42)}`);
    const tokenOut = getAddress(`0x${p.path.slice(-40)}`);
    lines.push({ label: t("cw.dapp.pay"), value: await amountOf(chain, tokenIn, p.amountIn), mono: true, tone: "down" });
    lines.push({ label: t("cw.dapp.minReceive"), value: await amountOf(chain, tokenOut, p.amountOutMinimum), mono: true, tone: "up" });
    lines.push({ label: t("cw.dapp.route"), value: t("cw.dapp.hops", { n: Math.round(hops) }) });
    if (self && p.recipient.toLowerCase() !== self) notes.push(t("cw.dapp.otherRecipientNote", { addr: short(p.recipient) }));
    return { title: t("cw.dapp.swapTitle"), lines, risk: self && p.recipient.toLowerCase() !== self ? "danger" : cname ? "none" : "warn", notes, known: true, ...base };
  }

  if (f === "launch") {
    const p = a[0] as { name: string; symbol: string; initialBuyUsdc: bigint };
    lines.push({ label: t("cw.dapp.token"), value: t("cw.dapp.nameSymbol", { name: p.name, sym: p.symbol }) });
    if (p.initialBuyUsdc > 0n) lines.push({ label: t("cw.dapp.initialBuy"), value: `${fmtNum(formatUnits(p.initialBuyUsdc, 6))} USDC`, mono: true, tone: "down" });
    lines.push({ label: t("cw.dapp.contract"), value: cname ?? to, mono: !cname });
    return { title: t("cw.dapp.launchTitle"), lines, risk: cname ? "none" : "danger", notes: cname ? notes : [t("cw.dapp.notArmFactory")], known: true, ...base };
  }

  const boatVault = isAt(id, to, BOAT.vault);
  const feeLocker = isAt(id, to, ADDR.locker, STOCK?.locker);
  if (boatVault && (f === "buy" || f === "sell")) {
    const [amt, min] = [a[0] as bigint, a[1] as bigint];
    const usdc = ADDR.usdc;
    lines.push({ label: t("cw.dapp.pay"), value: await amountOf(chain, f === "buy" ? usdc : BOAT.token, amt), mono: true, tone: "down" });
    lines.push({ label: t("cw.dapp.minReceive"), value: await amountOf(chain, f === "buy" ? BOAT.token : usdc, min), mono: true, tone: "up" });
    return { title: f === "buy" ? t("cw.dapp.buyBoat") : t("cw.dapp.sellBoat"), lines, risk: "none", notes, known: true, ...base };
  }
  if (boatVault && f === "deposit") {
    lines.push({ label: t("cw.dapp.amount"), value: await amountOf(chain, BOAT.token, a[0] as bigint), mono: true, tone: "down" });
    return { title: t("cw.dapp.depositBoat"), lines, risk: "none", notes, known: true, ...base };
  }
  if (boatVault && f === "claim") return { title: t("cw.dapp.claimBoat"), lines, risk: "none", notes, known: true, ...base };

  if (f === "claim" && feeLocker) {
    const asset = a[0] as Address;
    lines.push({ label: t("cw.dapp.claimAsset"), value: (await tokenMeta(chain, asset))?.symbol ?? short(asset) });
    return { title: t("cw.dapp.claimFees"), lines, risk: "none", notes, known: true, ...base };
  }
  if (f === "setPayout" && feeLocker) {
    lines.push({ label: t("cw.dapp.token"), value: short(a[0] as string), mono: true });
    lines.push({ label: t("cw.dapp.newPayout"), value: a[1] as string, mono: true });
    notes.push(t("cw.dapp.payoutNote"));
    return { title: t("cw.dapp.payoutTitle"), lines, risk: "warn", notes, known: true, ...base };
  }

  lines.push({ label: t("cw.dapp.contract"), value: cname ?? to, mono: !cname });
  lines.push({ label: t("cw.dapp.method"), value: f, mono: true });
  if (!cname) notes.push(t("cw.dapp.unknownCallNote"));
  return { title: t("cw.dapp.callTitle"), lines, risk: cname ? "none" : trustedSite ? "warn" : "danger", notes, known: false, ...base };
}

/** personal_sign payload: hex → readable text when it is UTF-8, else keep hex. */
export function readableMessage(data: string): { text: string; isHex: boolean } {
  if (!isHex(data)) return { text: data, isHex: false };
  try {
    const t = hexToString(data as Hex);
    if (!/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(t)) return { text: t, isHex: false };
  } catch {}
  return { text: data, isHex: true };
}

export const looksLikeLogin = (text: string) => /sign[- ]?in|log ?in|登录|nonce|wallet:|speedboat/i.test(text);

export type TypedData = { domain?: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
export type TypedView = { title: string; lines: Line[]; risk: Risk; notes: string[] };

const PERMITS = ["Permit", "PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom", "PermitWitnessTransferFrom"];

export function describeTyped(td: TypedData, chainId: number, trustedSite: boolean): TypedView {
  const lines: Line[] = [];
  const notes: string[] = [];
  const d = td.domain ?? {};
  const contract = typeof d.verifyingContract === "string" ? d.verifyingContract : undefined;
  if (d.name) lines.push({ label: t("cw.dapp.app"), value: String(d.name) });
  if (contract) lines.push({ label: t("cw.dapp.contract"), value: contractName(chainId, contract) ?? contract, mono: !contractName(chainId, contract) });
  lines.push({ label: t("cw.dapp.type"), value: td.primaryType, mono: true });
  let risk: Risk = "none";
  const dc = d.chainId != null ? Number(d.chainId) : null;
  if (dc != null && dc !== chainId) {
    risk = "danger";
    notes.push(t("cw.dapp.chainMismatch", { n: dc }));
  }
  if (PERMITS.includes(td.primaryType)) {
    const m = td.message as Record<string, unknown>;
    const details = (m.details ?? m.permitted) as Record<string, unknown> | undefined;
    const spender = String(m.spender ?? "");
    if (spender && isAddress(spender)) lines.push({ label: t("cw.dapp.spender"), value: contractName(chainId, spender) ?? spender, mono: !contractName(chainId, spender) });
    const amount = m.value ?? m.amount ?? details?.amount;
    if (amount != null) {
      let unlimited = false;
      try {
        unlimited = BigInt(String(amount)) >= 2n ** 159n; // Permit2 amounts are uint160
      } catch {}
      lines.push({ label: t("cw.dapp.amount"), value: unlimited ? t("cw.dapp.unlimited") : String(amount), mono: true });
    }
    if (!contractName(chainId, spender)) {
      risk = "danger";
      notes.push(t("cw.dapp.permitNote"));
    }
    return { title: t("cw.dapp.permitTitle"), lines, risk, notes };
  }
  if (/order/i.test(td.primaryType)) {
    risk = trustedSite ? "warn" : "danger";
    notes.push(t("cw.dapp.orderNote"));
  }
  if (!trustedSite && risk === "none") risk = "warn";
  return { title: t("cw.dapp.signTitle"), lines, risk, notes };
}
