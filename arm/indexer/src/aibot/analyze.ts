import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { perpMarket, perpWhales } from "../perp.js";
import { candles, type Candle, type HlAccount, type HlAsset } from "./hl.js";

/**
 * 「AI 合约」 analysis (wallet plan §5.8), the one copy used by both the wallet's manual mode (/api/ai/analyze, the user
 * confirms every order) and AI 托管 (the engine executes within the user's limits). The LLM call is billed to the user's
 * own key, which is only forwarded (manual) or decrypted for the call (托管), never logged.
 */

export const AI_PROVIDERS: Record<string, { base: string; model: string; json: boolean }> = {
  deepseek: { base: "https://api.deepseek.com", model: "deepseek-chat", json: true },
  siliconflow: { base: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", json: false },
  moonshot: { base: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", json: false },
  zhipu: { base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", json: false },
  qwen: { base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", json: true },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", json: true },
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini", json: true },
};

export type AiCfg = { provider: string; model: string; key: string; baseUrl?: string; maxLeverage: number; maxPct: number; minConfidence: number };
export type Usage = { prompt: number; completion: number; total: number };
export type Msg = { role: "system" | "user"; content: string };

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\.|^2[3-5]\d\./];
const isPrivate = (ip: string) => (isIP(ip) === 6 ? /^(::1?$|f[cd]|fe[89ab]|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip) : PRIVATE_V4.some((r) => r.test(ip)));

/** A user-typed OpenAI-compatible endpoint, called from this server: public https hosts only (no probing our own network) */
export async function customBase(raw: string | undefined): Promise<string> {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw new Error("自定义地址不对");
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) throw new Error("自定义地址要是 https:// 开头的公网地址");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length || ips.some(isPrivate)) throw new Error("自定义地址要是公网地址");
  return u.toString().replace(/\/+$/, "");
}

export class AiError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
  }
}

/** One OpenAI-compatible chat call; `fatal` errors (bad key, no balance) mean retrying is pointless */
export async function chat(cfg: Pick<AiCfg, "provider" | "model" | "key" | "baseUrl">, messages: Msg[], maxTokens = 1500): Promise<{ content: string; usage: Usage; model: string }> {
  const p = AI_PROVIDERS[cfg.provider];
  if (!p && cfg.provider !== "custom") throw new AiError("不支持这个服务商", true);
  if (!cfg.key || cfg.key.length > 300) throw new AiError("没填 API key", true);
  const base = p ? p.base : await customBase(cfg.baseUrl).catch((e) => Promise.reject(new AiError((e as Error).message, true)));
  const model = cfg.model || p?.model || "";
  if (!model) throw new AiError("自定义服务商要填模型名", true);
  const body = { model, messages, temperature: 0.3, max_tokens: Math.min(maxTokens, 4000), ...(p?.json ? { response_format: { type: "json_object" } } : {}) };
  let r: Response;
  try {
    r = await fetch(`${base}/chat/completions`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    throw new AiError(`连不上大模型服务：${(e as Error).message.slice(0, 80)}`, false);
  }
  const j = (await r.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: { message?: string } | string } | null;
  if (!r.ok || !j?.choices?.length) {
    const m = typeof j?.error === "string" ? j.error : (j?.error?.message ?? `HTTP ${r.status}`);
    if (/auth|api key|invalid.*key|unauthor/i.test(m) || r.status === 401 || r.status === 403) throw new AiError("API key 不对或已失效，请到「AI 设置」检查", true);
    if (/balance|quota|insufficient|arrear|余额/i.test(m) || r.status === 402) throw new AiError("大模型账户余额不足，请到服务商那里充值", true);
    if (/model/i.test(m) && /not|exist|found|invalid/i.test(m)) throw new AiError(`模型名不对：${m.slice(0, 80)}`, true);
    throw new AiError(`大模型返回错误：${m.slice(0, 120)}`, false);
  }
  const u = j.usage ?? {};
  return { content: j.choices[0].message?.content ?? "", model, usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, total: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) } };
}

/** Cheapest call that proves key + model work (JSON mode needs the word "json" in the prompt) */
export const ping = (cfg: Pick<AiCfg, "provider" | "model" | "key" | "baseUrl">) => chat(cfg, [{ role: "user", content: '只回复 JSON：{"ok":true}' }], 20);

// ---------- indicators ----------

const ema = (xs: number[], n: number) => {
  const k = 2 / (n + 1);
  let e = xs[0];
  for (const x of xs.slice(1)) e = x * k + e * (1 - k);
  return e;
};
function rsi(xs: number[], n = 14) {
  if (xs.length <= n) return 50;
  let up = 0, dn = 0;
  for (let i = xs.length - n; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) up += d;
    else dn -= d;
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
}
export function atr(cs: Candle[], n = 14) {
  const tr = cs.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - cs[i].c), Math.abs(c.l - cs[i].c)));
  const last = tr.slice(-n);
  return last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
}
const r6 = (x: number) => Number(x.toPrecision(6));
function frame(cs: Candle[], label: string) {
  const closes = cs.map((c) => c.c);
  return {
    周期: label,
    最近收盘: r6(closes.at(-1) ?? 0),
    EMA20: r6(ema(closes, 20)),
    EMA50: r6(ema(closes, 50)),
    RSI14: Math.round(rsi(closes)),
    ATR14: r6(atr(cs)),
    区间高: r6(Math.max(...cs.map((c) => c.h))),
    区间低: r6(Math.min(...cs.map((c) => c.l))),
    最近K线: cs.slice(-12).map((c) => [r6(c.o), r6(c.h), r6(c.l), r6(c.c)]),
  };
}

export async function marketContext(asset: HlAsset) {
  const [c15, c1h, c4h, mkt] = await Promise.all([candles(asset.name, "15m", 60), candles(asset.name, "1h", 72), candles(asset.name, "4h", 60), perpMarket().catch(() => null)]);
  const wh = perpWhales();
  let longNtl = 0, shortNtl = 0;
  if (wh.status === "ready") for (const w of wh.whales) for (const p of w.positions) if (p.coin === asset.name) (p.side === "long" ? (longNtl += p.ntl) : (shortNtl += p.ntl));
  const oiChg = mkt?.coins.find((c) => c.coin === asset.name)?.oiChg1h;
  return {
    atr1h: atr(c1h),
    data: {
      币: asset.name,
      标记价: r6(asset.mark),
      "24h涨跌%": Number(((asset.mark / asset.prevDay - 1) * 100).toFixed(2)),
      "资金费率(每小时%)": Number((asset.funding * 100).toFixed(5)),
      "持仓量(美元)": Math.round(asset.oi),
      "1小时持仓变化%": oiChg == null ? null : Number((oiChg * 100).toFixed(2)),
      "24h成交额(美元)": Math.round(asset.volume),
      "全市场贪婪指数(0-100)": mkt?.greed.value ?? null,
      "头部巨鲸在这个币上的多单(美元)": Math.round(longNtl),
      "头部巨鲸在这个币上的空单(美元)": Math.round(shortNtl),
      最大杠杆: asset.maxLeverage,
      K线: [frame(c15, "15分钟"), frame(c1h, "1小时"), frame(c4h, "4小时")],
    },
  };
}

// ---------- the decision ----------

export type AiDecision = {
  action: "long" | "short" | "close" | "hold" | "wait";
  confidence: number;
  leverage: number;
  sizePct: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  summary: string;
  reasons: string[];
  risks: string[];
  horizon: string;
};
export type AiResult = { decision: AiDecision; warnings: string[]; usage: Usage; at: number; coin: string; price: number; model: string };

const RULES = `规则：
1. 只输出一个 JSON 对象，不要任何别的文字。字段：
{"action":"long|short|close|hold|wait","confidence":0到100的整数,"leverage":整数,"sizePct":数字,"entry":数字或null,"stopLoss":数字或null,"takeProfit":数字或null,"summary":"一句话结论","reasons":["理由",...],"risks":["风险",...],"horizon":"预计持有多久"}
2. action：long 开多、short 开空；用户已有这个币的仓位时可以 close（平掉）或 hold（继续拿）；看不清方向就 wait。
3. 开仓必须给止损；止盈止损要在入场价两侧（多单 止损<入场<止盈，空单相反），盈亏比至少 1.5；止损距离参考 ATR，不要小于 1 倍 1小时ATR。
4. leverage 不超过用户上限；sizePct 是拿可用余额的百分之几做保证金，不超过用户上限。信心不足 60 就选 wait。
5. entry 为 null 表示按市价；给限价时要合理（离现价不超过 1.5 倍 1小时ATR）。
6. 注意资金费率（多空拥挤）、持仓量变化、巨鲸方向，以及多个周期是否一致。
7. summary、reasons、risks 用简体中文，简洁具体，reasons 2-4 条，risks 1-3 条，说到关键价位。`;
const SYSTEM = {
  manual: `你是一个谨慎的加密货币永续合约交易分析师，帮用户在 Hyperliquid 上做决策。你只给建议，用户自己决定下不下单。\n${RULES}`,
  hosted: `你是一个谨慎的加密货币永续合约交易员，替用户托管 Hyperliquid 账户，每 15 分钟看一次盘。你的决策会按市价自动执行（entry 会被忽略），所以宁可错过也不要乱开仓；已有仓位时优先判断该继续拿还是平掉，不要频繁进出。\n${RULES}`,
};

export function extractJson(s: string): unknown {
  const t = s.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new AiError("大模型没有按格式回答", false);
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new AiError("大模型没有按格式回答", false);
  }
}

type Limits = Pick<AiCfg, "maxLeverage" | "maxPct" | "minConfidence">;
/** Clamps the model's numbers to the user's limits and drops anything on the wrong side */
export function vetDecision(raw: unknown, asset: HlAsset, cfg: Limits): { decision: AiDecision; warnings: string[] } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  const actions = ["long", "short", "close", "hold", "wait"] as const;
  const action = (actions as readonly string[]).includes(String(o.action)) ? (o.action as AiDecision["action"]) : "wait";
  const warnings: string[] = [];
  const maxLev = Math.min(cfg.maxLeverage, asset.maxLeverage);
  let leverage = Math.round(n(o.leverage) ?? 1);
  if (leverage > maxLev) {
    warnings.push(`AI 给的杠杆 ${leverage} 倍超过你的上限，已改成 ${maxLev} 倍`);
    leverage = maxLev;
  }
  let sizePct = n(o.sizePct) ?? 0;
  if (sizePct > cfg.maxPct) {
    warnings.push(`AI 建议用 ${sizePct}% 的余额，超过你的上限，已改成 ${cfg.maxPct}%`);
    sizePct = cfg.maxPct;
  }
  const d: AiDecision = {
    action,
    confidence: Math.max(0, Math.min(100, Math.round(n(o.confidence) ?? 0))),
    leverage: Math.max(1, leverage),
    sizePct: Math.max(0, sizePct),
    entry: n(o.entry),
    stopLoss: n(o.stopLoss),
    takeProfit: n(o.takeProfit),
    summary: String(o.summary ?? "").slice(0, 200),
    reasons: Array.isArray(o.reasons) ? o.reasons.map(String).slice(0, 5) : [],
    risks: Array.isArray(o.risks) ? o.risks.map(String).slice(0, 4) : [],
    horizon: String(o.horizon ?? "").slice(0, 40),
  };
  if (d.action === "long" || d.action === "short") {
    const ref = d.entry ?? asset.mark;
    if (d.stopLoss && (d.action === "long" ? d.stopLoss >= ref : d.stopLoss <= ref)) {
      warnings.push("AI 给的止损价在错误的一侧，已去掉，请自己设");
      d.stopLoss = null;
    } else if (!d.stopLoss) warnings.push("AI 没给止损，下单前请自己设");
    if (d.takeProfit && (d.action === "long" ? d.takeProfit <= ref : d.takeProfit >= ref)) {
      warnings.push("AI 给的止盈价在错误的一侧，已去掉");
      d.takeProfit = null;
    }
    if (d.entry && Math.abs(d.entry / asset.mark - 1) > 0.05) warnings.push("限价离现价超过 5%，可能很久不成交");
    if (d.confidence < cfg.minConfidence) warnings.push(`信心 ${d.confidence} 低于你设的 ${cfg.minConfidence}，建议观望`);
  }
  return { decision: d, warnings };
}

export async function analyze(cfg: AiCfg, asset: HlAsset, acct: HlAccount | null, mode: "manual" | "hosted"): Promise<AiResult & { atr1h: number }> {
  const { data, atr1h } = await marketContext(asset);
  const pos = acct?.positions.find((p) => p.coin === asset.name);
  const user = {
    "可用余额(USDC)": acct ? Number(acct.available.toFixed(2)) : 0,
    "账户权益(USDC)": acct ? Number(acct.equity.toFixed(2)) : 0,
    当前这个币的仓位: pos ? { 方向: pos.side === "long" ? "多" : "空", 数量: pos.size, 开仓价: pos.entry, 强平价: pos.liq, 杠杆: pos.leverage, 浮盈: Number(pos.upnl.toFixed(2)) } : "无",
    其它持仓数: acct ? acct.positions.filter((p) => p.coin !== asset.name).length : 0,
    用户杠杆上限: Math.min(cfg.maxLeverage, asset.maxLeverage),
    "单笔保证金上限(可用余额的%)": cfg.maxPct,
  };
  const { content, usage, model } = await chat(cfg, [
    { role: "system", content: SYSTEM[mode] },
    { role: "user", content: `现在时间 ${new Date().toISOString()}。\n市场数据：${JSON.stringify(data)}\n用户情况：${JSON.stringify(user)}\n请给出决策 JSON。` },
  ]);
  const { decision, warnings } = vetDecision(extractJson(content), asset, cfg);
  return { decision, warnings, usage, at: Date.now(), coin: asset.name, price: asset.mark, model, atr1h };
}

/** User limits from a request body, clamped to sane ranges */
export function readLimits(b: Record<string, unknown>): Limits {
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return { maxLeverage: Math.round(num(b.maxLeverage, 1, 20, 5)), maxPct: num(b.maxPct, 1, 100, 20), minConfidence: Math.round(num(b.minConfidence, 0, 100, 60)) };
}
