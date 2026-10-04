import { API_BASE } from "@/lib/api";
import { candles, type Candle, type HlAccount, type HlAsset } from "./hl";

/**
 * 「AI 合约」 analysis with the user's own LLM key (wallet plan §5.8). The model only suggests; the wallet shows the
 * suggestion and the user decides whether to place it. Built-in providers go through the indexer relay (/api/ai/chat,
 * key forwarded, never stored); a custom OpenAI-compatible endpoint is called straight from the device.
 */

export type AiProvider = { id: string; name: string; model: string; keyUrl?: string; json: boolean; note?: string };
export const AI_PROVIDERS: AiProvider[] = [
  { id: "deepseek", name: "DeepSeek", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", json: true, note: "推荐：国内直连、便宜，一次分析大约几分钱" },
  { id: "siliconflow", name: "硅基流动", model: "deepseek-ai/DeepSeek-V3", keyUrl: "https://cloud.siliconflow.cn/account/ak", json: false },
  { id: "qwen", name: "通义千问", model: "qwen-plus", keyUrl: "https://bailian.console.aliyun.com/?apiKey=1", json: true },
  { id: "moonshot", name: "Kimi", model: "moonshot-v1-32k", keyUrl: "https://platform.moonshot.cn/console/api-keys", json: false },
  { id: "zhipu", name: "智谱 GLM", model: "glm-4-flash", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", json: false },
  { id: "openrouter", name: "OpenRouter", model: "deepseek/deepseek-chat", keyUrl: "https://openrouter.ai/keys", json: true },
  { id: "openai", name: "OpenAI", model: "gpt-4o-mini", keyUrl: "https://platform.openai.com/api-keys", json: true, note: "服务器在香港，OpenAI 可能拒绝；可改用自定义地址直连" },
  { id: "custom", name: "自定义（OpenAI 兼容）", model: "", json: false, note: "从手机直接请求你填的地址，不经过心之音服务器" },
];
export const providerOf = (id: string) => AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];

export type AiConfig = { provider: string; model: string; key: string; baseUrl?: string; maxLeverage: number; maxPct: number; minConfidence: number };
export const AI_CONFIG_KEY = "ai:config";
export const DEFAULT_RISK = { maxLeverage: 5, maxPct: 20, minConfidence: 60 };
export const parseAiConfig = (s: string | null): AiConfig | null => {
  try {
    const c = s ? (JSON.parse(s) as AiConfig) : null;
    return c?.key ? { ...DEFAULT_RISK, ...c } : null;
  } catch {
    return null;
  }
};

export type Usage = { prompt: number; completion: number; total: number };
type Msg = { role: "system" | "user"; content: string };

export async function aiChat(cfg: AiConfig, messages: Msg[], maxTokens = 1500): Promise<{ content: string; usage: Usage }> {
  const p = providerOf(cfg.provider);
  const model = cfg.model || p.model;
  const body: Record<string, unknown> = { model, messages, temperature: 0.3, max_tokens: maxTokens, ...(p.json ? { response_format: { type: "json_object" } } : {}) };
  let r: Response;
  if (p.id === "custom") {
    if (!cfg.baseUrl || !/^https:\/\//.test(cfg.baseUrl)) throw new Error("自定义地址要以 https:// 开头");
    r = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` }, body: JSON.stringify(body) });
  } else {
    r = await fetch(`${API_BASE}/ai/chat`, { method: "POST", headers: { "content-type": "application/json", "x-ai-key": cfg.key }, body: JSON.stringify({ provider: p.id, ...body }) });
  }
  const j = (await r.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: { message?: string } | string } | null;
  if (!r.ok || !j?.choices?.length) {
    const m = typeof j?.error === "string" ? j.error : (j?.error?.message ?? `HTTP ${r.status}`);
    throw new Error(/auth|api key|invalid|unauthor|401/i.test(m) || r.status === 401 ? "API key 不对或已失效，请到「AI 设置」检查" : /balance|quota|insufficient|402/i.test(m) || r.status === 402 ? "大模型账户余额不足，请到服务商那里充值" : `大模型返回错误：${m}`);
  }
  const u = j.usage ?? {};
  return { content: j.choices[0].message?.content ?? "", usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, total: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) } };
}

// ---------- indicators (computed here so the prompt stays short) ----------

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
function atr(cs: Candle[], n = 14) {
  const tr = cs.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - cs[i].c), Math.abs(c.l - cs[i].c)));
  const last = tr.slice(-n);
  return last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
}
const r = (x: number) => Number(x.toPrecision(6));
function frame(cs: Candle[], label: string) {
  const closes = cs.map((c) => c.c);
  return {
    周期: label,
    最近收盘: r(closes.at(-1) ?? 0),
    EMA20: r(ema(closes, 20)),
    EMA50: r(ema(closes, 50)),
    RSI14: Math.round(rsi(closes)),
    ATR14: r(atr(cs)),
    区间高: r(Math.max(...cs.map((c) => c.h))),
    区间低: r(Math.min(...cs.map((c) => c.l))),
    // last bars as [开, 高, 低, 收]
    最近K线: cs.slice(-12).map((c) => [r(c.o), r(c.h), r(c.l), r(c.c)]),
  };
}

export type PerpMarketBrief = { greed?: { value: number }; coins?: { coin: string; oiChg1h: number | null }[] };
export type WhaleBrief = { whales?: { positions: { coin: string; side: "long" | "short"; ntl: number }[] }[] };

export async function marketContext(asset: HlAsset) {
  const [c15, c1h, c4h, mkt, wh] = await Promise.all([
    candles(asset.name, "15m", 60),
    candles(asset.name, "1h", 72),
    candles(asset.name, "4h", 60),
    fetch(`${API_BASE}/perp/market`).then((x) => x.json() as Promise<PerpMarketBrief>).catch(() => null),
    fetch(`${API_BASE}/perp/whales`).then((x) => x.json() as Promise<WhaleBrief>).catch(() => null),
  ]);
  let longNtl = 0, shortNtl = 0;
  for (const w of wh?.whales ?? []) for (const p of w.positions) if (p.coin === asset.name) (p.side === "long" ? (longNtl += p.ntl) : (shortNtl += p.ntl));
  return {
    币: asset.name,
    标记价: r(asset.mark),
    "24h涨跌%": Number(((asset.mark / asset.prevDay - 1) * 100).toFixed(2)),
    "资金费率(每小时%)": Number((asset.funding * 100).toFixed(5)),
    "持仓量(美元)": Math.round(asset.oi),
    "1小时持仓变化%": (() => {
      const x = mkt?.coins?.find((c) => c.coin === asset.name)?.oiChg1h;
      return x == null ? null : Number((x * 100).toFixed(2));
    })(),
    "24h成交额(美元)": Math.round(asset.volume),
    "全市场贪婪指数(0-100)": mkt?.greed?.value ?? null,
    "头部巨鲸在这个币上的多单(美元)": Math.round(longNtl),
    "头部巨鲸在这个币上的空单(美元)": Math.round(shortNtl),
    最大杠杆: asset.maxLeverage,
    K线: [frame(c15, "15分钟"), frame(c1h, "1小时"), frame(c4h, "4小时")],
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

const SYSTEM = `你是一个谨慎的加密货币永续合约交易分析师，帮用户在 Hyperliquid 上做决策。你只给建议，用户自己决定下不下单。
规则：
1. 只输出一个 JSON 对象，不要任何别的文字。字段：
{"action":"long|short|close|hold|wait","confidence":0到100的整数,"leverage":整数,"sizePct":数字,"entry":数字或null,"stopLoss":数字或null,"takeProfit":数字或null,"summary":"一句话结论","reasons":["理由",...],"risks":["风险",...],"horizon":"预计持有多久"}
2. action：long 开多、short 开空；用户已有这个币的仓位时可以 close（平掉）或 hold（继续拿）；看不清方向就 wait。
3. 开仓必须给止损；止盈止损要在入场价两侧（多单 止损<入场<止盈，空单相反），盈亏比至少 1.5；止损距离参考 ATR，不要小于 1 倍 1小时ATR。
4. leverage 不超过用户上限；sizePct 是拿可用余额的百分之几做保证金，不超过用户上限。信心不足 60 就选 wait。
5. entry 为 null 表示按市价；给限价时要合理（离现价不超过 1.5 倍 1小时ATR）。
6. 注意资金费率（多空拥挤）、持仓量变化、巨鲸方向，以及多个周期是否一致。
7. summary、reasons、risks 用简体中文，简洁具体，reasons 2-4 条，risks 1-3 条，说到关键价位。`;

function extractJson(s: string): unknown {
  const t = s.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("大模型没有按格式回答，再试一次");
  return JSON.parse(t.slice(a, b + 1));
}

/** Clamps the model's numbers to the user's limits and flags anything inconsistent */
export function vetDecision(raw: unknown, asset: HlAsset, cfg: AiConfig): { decision: AiDecision; warnings: string[] } {
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

export async function analyze(cfg: AiConfig, asset: HlAsset, acct: HlAccount | null): Promise<AiResult> {
  const market = await marketContext(asset);
  const pos = acct?.positions.find((p) => p.coin === asset.name);
  const user = {
    "可用余额(USDC)": acct ? Number(acct.available.toFixed(2)) : 0,
    "账户权益(USDC)": acct ? Number(acct.equity.toFixed(2)) : 0,
    当前这个币的仓位: pos ? { 方向: pos.side === "long" ? "多" : "空", 数量: pos.size, 开仓价: pos.entry, 强平价: pos.liq, 杠杆: pos.leverage, 浮盈: Number(pos.upnl.toFixed(2)) } : "无",
    其它持仓数: acct ? acct.positions.filter((p) => p.coin !== asset.name).length : 0,
    用户杠杆上限: Math.min(cfg.maxLeverage, asset.maxLeverage),
    "单笔保证金上限(可用余额的%)": cfg.maxPct,
  };
  const { content, usage } = await aiChat(cfg, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `现在时间 ${new Date().toISOString()}。\n市场数据：${JSON.stringify(market)}\n用户情况：${JSON.stringify(user)}\n请给出决策 JSON。` },
  ]);
  const { decision, warnings } = vetDecision(extractJson(content), asset, cfg);
  return { decision, warnings, usage, at: Date.now(), coin: asset.name, price: asset.mark, model: cfg.model || providerOf(cfg.provider).model };
}
