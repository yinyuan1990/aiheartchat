import { decodeFunctionData, erc20Abi as viemErc20Abi, formatUnits, getAddress, hexToString, isAddress, isHex, parseAbi, type Abi, type Address, type Hex } from "viem";
import { ADDR, STOCK, factoryAbi, lockerAbi, routerAbi, stockFactoryAbi } from "@/lib/web3";
import { vaultAbi } from "@/lib/boat";
import { publicClientFor, type WalletChain } from "./chains";

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
    [ADDR.factory]: "Arm 发币工厂",
    [ADDR.locker]: "Arm 手续费金库",
    [ADDR.router]: "Arm 交易路由（Uniswap V3）",
    [ADDR.quoter]: "Uniswap V3 报价",
    [ADDR.positionManager]: "Uniswap V3 仓位",
    [ADDR.treasury]: "Arm 国库",
    [BOAT.vault]: "$BOAT 金库",
    [BOAT.token]: "$BOAT 代币",
    [ADDR.usdc]: "USDC",
  };
  if (ADDR.referralHub) m[ADDR.referralHub] = "Arm 推广中心";
  if (STOCK) {
    m[STOCK.factory] = "Arm 发币工厂（股票币）";
    m[STOCK.locker] = "Arm 手续费金库（股票币）";
  }
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([k, v]) => [k.toLowerCase(), v!]));
}
export const contractName = (chainId: number, a?: string | null) => (a ? knownContracts(chainId)[a.toLowerCase()] : undefined);

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
  return m ? `${fmtNum(formatUnits(raw, m.decimals))} ${m.symbol}` : `${raw.toString()}（原始数量，${short(token)}）`;
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
  if (value > 0n) lines.push({ label: "支付", value: `${fmtNum(formatUnits(value, nc.decimals))} ${nc.symbol}`, mono: true, tone: "down" });

  if (!to) return { title: "部署合约", lines, risk: "warn", notes: ["这笔交易会部署一个新合约。不清楚用途就拒绝。"], known: false };

  if (!tx.data || tx.data === "0x") {
    lines.push({ label: "收款地址", value: to, mono: true });
    return { title: `转出 ${nc.symbol}`, lines, risk: "none", notes, contract: cname, known: true };
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
    lines.push({ label: "合约", value: cname ?? to, mono: !cname });
    lines.push({ label: "方法", value: tx.data.slice(0, 10), mono: true });
    notes.push(cname ? "没能解析这次调用的具体内容，请确认是你自己发起的操作。" : "未知合约的调用，无法解析内容。不认识这个网站就拒绝。");
    return { title: "合约调用", lines, risk: cname || trustedSite ? "warn" : "danger", notes, known: false, ...base };
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
    lines.push({ label: "代币", value: sym });
    lines.push({ label: "授权给", value: sname ?? spender, mono: !sname });
    lines.push({ label: "数量", value: amt === 0n ? "0（取消授权）" : unlimited ? "无限" : await amountOf(chain, to, amt), tone: unlimited ? "down" : undefined });
    if (amt === 0n) return { title: `取消 ${sym} 授权`, lines, risk: "none", notes, known: true, ...base };
    let risk: Risk = "none";
    if (!sname) {
      risk = unlimited || !trustedSite ? "danger" : "warn";
      notes.push(`授权后对方合约可以随时转走你${unlimited ? "全部" : "这个数量以内"}的 ${sym}。不认识这个合约就拒绝。`);
    } else if (unlimited) notes.push(`这是 Arm 自己的合约，网站交易前都要先授权一次。`);
    return { title: unlimited ? `无限授权 ${sym}` : `授权 ${sym}`, lines, risk, notes, known: true, ...base };
  }

  if (f === "transfer" || f === "transferFrom") {
    const [src, dst, amt] = f === "transfer" ? [tx.from, a[0] as Address, a[1] as bigint] : [a[0] as Address, a[1] as Address, a[2] as bigint];
    lines.push({ label: "数量", value: await amountOf(chain, to, amt), mono: true, tone: "down" });
    if (f === "transferFrom" && src && src.toLowerCase() !== self) lines.push({ label: "从", value: src, mono: true });
    lines.push({ label: "收款地址", value: dst, mono: true });
    const meta = await tokenMeta(chain, to);
    if (!trustedSite) notes.push("网站请求你直接转出代币，确认收款地址是你要转的人。");
    return { title: `转出 ${meta?.symbol ?? "代币"}`, lines, risk: trustedSite ? "none" : "warn", notes, known: true, ...base };
  }

  if (f === "setApprovalForAll") {
    const on = a[1] as boolean;
    const op = getAddress(a[0] as Address);
    lines.push({ label: "合约", value: cname ?? to, mono: !cname });
    lines.push({ label: "授权给", value: nameOr(id, op), mono: true });
    if (!on) return { title: "取消 NFT 全部授权", lines, risk: "none", notes, known: true, ...base };
    notes.push("授权后对方可以转走你在这个合约里的全部 NFT。钓鱼网站最常用这一招。");
    return { title: "授权全部 NFT", lines, risk: "danger", notes, known: true, ...base };
  }

  if (f === "exactInputSingle") {
    const p = a[0] as { tokenIn: Address; tokenOut: Address; recipient: Address; amountIn: bigint; amountOutMinimum: bigint };
    lines.push({ label: "支付", value: await amountOf(chain, p.tokenIn, p.amountIn), mono: true, tone: "down" });
    lines.push({ label: "最少得到", value: await amountOf(chain, p.tokenOut, p.amountOutMinimum), mono: true, tone: "up" });
    lines.push({ label: "合约", value: cname ?? to, mono: !cname });
    if (self && p.recipient.toLowerCase() !== self) notes.push(`换到的币会打到 ${short(p.recipient)}，不是你的地址。`);
    return { title: "兑换", lines, risk: self && p.recipient.toLowerCase() !== self ? "danger" : cname ? "none" : "warn", notes, known: true, ...base };
  }

  if (f === "exactInput") {
    const p = a[0] as { path: Hex; recipient: Address; amountIn: bigint; amountOutMinimum: bigint };
    const hops = (p.path.length - 2) / 46; // 20-byte token + 3-byte fee per hop, hex chars
    const tokenIn = getAddress(`0x${p.path.slice(2, 42)}`);
    const tokenOut = getAddress(`0x${p.path.slice(-40)}`);
    lines.push({ label: "支付", value: await amountOf(chain, tokenIn, p.amountIn), mono: true, tone: "down" });
    lines.push({ label: "最少得到", value: await amountOf(chain, tokenOut, p.amountOutMinimum), mono: true, tone: "up" });
    lines.push({ label: "路径", value: `${Math.round(hops)} 跳` });
    if (self && p.recipient.toLowerCase() !== self) notes.push(`换到的币会打到 ${short(p.recipient)}，不是你的地址。`);
    return { title: "兑换", lines, risk: self && p.recipient.toLowerCase() !== self ? "danger" : cname ? "none" : "warn", notes, known: true, ...base };
  }

  if (f === "launch") {
    const p = a[0] as { name: string; symbol: string; initialBuyUsdc: bigint };
    lines.push({ label: "代币", value: `${p.name}（$${p.symbol}）` });
    if (p.initialBuyUsdc > 0n) lines.push({ label: "首购", value: `${fmtNum(formatUnits(p.initialBuyUsdc, 6))} USDC`, mono: true, tone: "down" });
    lines.push({ label: "合约", value: cname ?? to, mono: !cname });
    return { title: "发币", lines, risk: cname ? "none" : "danger", notes: cname ? notes : ["这不是 Arm 的发币合约。"], known: true, ...base };
  }

  if (cname === "$BOAT 金库" && (f === "buy" || f === "sell")) {
    const [amt, min] = [a[0] as bigint, a[1] as bigint];
    const usdc = ADDR.usdc;
    lines.push({ label: "支付", value: await amountOf(chain, f === "buy" ? usdc : BOAT.token, amt), mono: true, tone: "down" });
    lines.push({ label: "最少得到", value: await amountOf(chain, f === "buy" ? BOAT.token : usdc, min), mono: true, tone: "up" });
    return { title: f === "buy" ? "买入 $BOAT" : "卖出 $BOAT", lines, risk: "none", notes, known: true, ...base };
  }
  if (cname === "$BOAT 金库" && f === "deposit") {
    lines.push({ label: "数量", value: await amountOf(chain, BOAT.token, a[0] as bigint), mono: true, tone: "down" });
    return { title: "把 $BOAT 存进游戏", lines, risk: "none", notes, known: true, ...base };
  }
  if (cname === "$BOAT 金库" && f === "claim") return { title: "领取 $BOAT 奖励", lines, risk: "none", notes, known: true, ...base };

  if (f === "claim" && cname?.startsWith("Arm 手续费金库")) {
    const asset = a[0] as Address;
    lines.push({ label: "领取", value: (await tokenMeta(chain, asset))?.symbol ?? short(asset) });
    return { title: "领取手续费收益", lines, risk: "none", notes, known: true, ...base };
  }
  if (f === "setPayout" && cname?.startsWith("Arm 手续费金库")) {
    lines.push({ label: "代币", value: short(a[0] as string), mono: true });
    lines.push({ label: "新收款地址", value: a[1] as string, mono: true });
    notes.push("以后这个币的创作者收益会打到新地址。");
    return { title: "修改收益地址", lines, risk: "warn", notes, known: true, ...base };
  }

  lines.push({ label: "合约", value: cname ?? to, mono: !cname });
  lines.push({ label: "方法", value: f, mono: true });
  if (!cname) notes.push("调用未知合约。不认识这个网站就拒绝。");
  return { title: "合约调用", lines, risk: cname ? "none" : trustedSite ? "warn" : "danger", notes, known: false, ...base };
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
  if (d.name) lines.push({ label: "应用", value: String(d.name) });
  if (contract) lines.push({ label: "合约", value: contractName(chainId, contract) ?? contract, mono: !contractName(chainId, contract) });
  lines.push({ label: "类型", value: td.primaryType, mono: true });
  let risk: Risk = "none";
  const dc = d.chainId != null ? Number(d.chainId) : null;
  if (dc != null && dc !== chainId) {
    risk = "danger";
    notes.push(`签名里写的链（${dc}）和当前网络不一致。`);
  }
  if (PERMITS.includes(td.primaryType)) {
    const m = td.message as Record<string, unknown>;
    const details = (m.details ?? m.permitted) as Record<string, unknown> | undefined;
    const spender = String(m.spender ?? "");
    if (spender && isAddress(spender)) lines.push({ label: "授权给", value: contractName(chainId, spender) ?? spender, mono: !contractName(chainId, spender) });
    const amount = m.value ?? m.amount ?? details?.amount;
    if (amount != null) {
      let unlimited = false;
      try {
        unlimited = BigInt(String(amount)) >= 2n ** 159n; // Permit2 amounts are uint160
      } catch {}
      lines.push({ label: "数量", value: unlimited ? "无限" : String(amount), mono: true });
    }
    if (!contractName(chainId, spender)) {
      risk = "danger";
      notes.push("这是代币授权签名（Permit）：签了之后对方不用你再确认就能转走代币。钓鱼网站常用这一招，不认识就拒绝。");
    }
    return { title: "代币授权签名", lines, risk, notes };
  }
  if (/order/i.test(td.primaryType)) {
    risk = trustedSite ? "warn" : "danger";
    notes.push("这是挂单 / 订单签名，签了可能让别人按这个价格买走你的资产。");
  }
  if (!trustedSite && risk === "none") risk = "warn";
  return { title: "签名请求", lines, risk, notes };
}
