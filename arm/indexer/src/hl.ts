/**
 * Wallet relays for 「AI 合约」 (wallet plan §5.8): Hyperliquid's info / exchange endpoints (api.hyperliquid.xyz is not reliably
 * reachable from mainland China) and the user's own LLM key. Nothing here holds keys or funds:
 *  - /api/hl/exchange forwards actions the wallet already signed (agent key or main wallet), so the relay cannot change them;
 *  - /api/ai/chat forwards an OpenAI-compatible chat call with the key the user typed into their wallet, to an allow-listed
 *    provider only (not an open proxy). The key is never logged or stored.
 */

const HL = "https://api.hyperliquid.xyz";
const INFO_TYPES = new Set([
  "meta", "metaAndAssetCtxs", "allMids", "l2Book", "candleSnapshot",
  "clearinghouseState", "openOrders", "frontendOpenOrders", "userFills", "userFillsByTime", "orderStatus",
  "maxBuilderFee", "extraAgents", "userRole", "userFees", "spotClearinghouseState", "fundingHistory", "userAbstraction",
]);
/** shared answers: market data only, never per-user state */
const INFO_TTL: Record<string, number> = { meta: 60_000, metaAndAssetCtxs: 2_000, allMids: 1_000, candleSnapshot: 15_000, fundingHistory: 60_000 };

type Reply = { status: number; json: unknown };
const cache = new Map<string, { at: number; v: Reply }>();

function limiter(perMin: number) {
  const hits = new Map<string, { at: number; n: number }>();
  return (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.at > 60_000) {
      hits.set(ip, { at: now, n: 1 });
      if (hits.size > 50_000) hits.clear();
      return true;
    }
    return ++h.n <= perMin;
  };
}
const infoLimit = limiter(300);
const exchangeLimit = limiter(60);
const aiLimit = limiter(30);

async function post(url: string, body: unknown, headers: Record<string, string> = {}, timeout = 15_000): Promise<Reply> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 300) || `HTTP ${r.status}` };
  }
  return { status: r.status, json };
}

export async function hlInfo(body: unknown, ip: string): Promise<Reply> {
  const type = (body as { type?: unknown })?.type;
  if (typeof type !== "string" || !INFO_TYPES.has(type)) return { status: 400, json: { error: "info type not allowed" } };
  if (!infoLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  const ttl = INFO_TTL[type] ?? 0;
  const key = ttl ? JSON.stringify(body) : "";
  const hit = key ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  try {
    const v = await post(`${HL}/info`, body);
    if (key && v.status === 200) {
      if (cache.size > 5_000) cache.clear();
      cache.set(key, { at: Date.now(), v });
    }
    return v;
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
  }
}

export async function hlExchange(body: unknown, ip: string): Promise<Reply> {
  const b = body as { action?: { type?: unknown }; nonce?: unknown; signature?: { r?: unknown; s?: unknown; v?: unknown } };
  if (!b?.action || typeof b.action.type !== "string" || typeof b.nonce !== "number" || typeof b.signature?.r !== "string") return { status: 400, json: { error: "bad request" } };
  if (!exchangeLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  try {
    return await post(`${HL}/exchange`, body);
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
  }
}

/** OpenAI-compatible providers the relay may call; anything else the wallet calls directly from the device. */
export const AI_PROVIDERS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  siliconflow: "https://api.siliconflow.cn/v1",
  moonshot: "https://api.moonshot.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

export async function aiChat(body: unknown, key: string | undefined, ip: string): Promise<Reply> {
  const b = body as { provider?: unknown; model?: unknown; messages?: unknown; temperature?: unknown; response_format?: unknown; max_tokens?: unknown };
  const base = typeof b?.provider === "string" ? AI_PROVIDERS[b.provider] : undefined;
  if (!base) return { status: 400, json: { error: "provider not allowed" } };
  if (!key || key.length > 300) return { status: 400, json: { error: "missing key" } };
  if (typeof b.model !== "string" || !Array.isArray(b.messages) || JSON.stringify(b.messages).length > 120_000) return { status: 400, json: { error: "bad request" } };
  if (!aiLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  const payload = { model: b.model, messages: b.messages, temperature: typeof b.temperature === "number" ? b.temperature : 0.3, max_tokens: typeof b.max_tokens === "number" ? Math.min(b.max_tokens, 4000) : 1500, ...(b.response_format ? { response_format: b.response_format } : {}) };
  try {
    return await post(`${base}/chat/completions`, payload, { authorization: `Bearer ${key}` }, 90_000);
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
  }
}
