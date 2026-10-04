import { API_BASE } from "@/lib/api";

/**
 * 「AI 合约」 with the user's own LLM key (wallet plan §5.8). The prompt, indicators and the limit checks live on the
 * indexer (`indexer/src/aibot/analyze.ts`), shared by manual mode (here: the user confirms every order) and AI 托管.
 * The key is sent in a header for each call and never stored on the server in manual mode.
 */

export type AiProvider = { id: string; name: string; model: string; keyUrl?: string; note?: string };
export const AI_PROVIDERS: AiProvider[] = [
  { id: "deepseek", name: "DeepSeek", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", note: "推荐：国内直连、便宜，一次分析大约几分钱" },
  { id: "siliconflow", name: "硅基流动", model: "deepseek-ai/DeepSeek-V3", keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  { id: "qwen", name: "通义千问", model: "qwen-plus", keyUrl: "https://bailian.console.aliyun.com/?apiKey=1" },
  { id: "moonshot", name: "Kimi", model: "moonshot-v1-32k", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  { id: "zhipu", name: "智谱 GLM", model: "glm-4-flash", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "openrouter", name: "OpenRouter", model: "deepseek/deepseek-chat", keyUrl: "https://openrouter.ai/keys" },
  { id: "openai", name: "OpenAI", model: "gpt-4o-mini", keyUrl: "https://platform.openai.com/api-keys", note: "服务器在香港，OpenAI 可能拒绝" },
  { id: "custom", name: "自定义（OpenAI 兼容）", model: "", note: "填 https 公网地址，由服务器转发" },
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

async function call<T>(path: string, cfg: AiConfig, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${API_BASE}/ai/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ai-key": cfg.key },
    body: JSON.stringify({ provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, ...body }),
  });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !j) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

export const testAi = (cfg: AiConfig) => call<{ ok: boolean; model: string }>("test", cfg, {});

/** One analysis of `coin` for `user` (their Hyperliquid account is read on the server) */
export const analyze = (cfg: AiConfig, coin: string, user?: string) =>
  call<AiResult>("analyze", cfg, { coin, user, maxLeverage: cfg.maxLeverage, maxPct: cfg.maxPct, minConfidence: cfg.minConfidence });
