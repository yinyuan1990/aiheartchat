/**
 * 「AI 模型」 relay for the wallet: BlockRun's OpenAI-compatible gateway, paid per call in USDC on Base over x402.
 * BlockRun sends no CORS headers and mainland users can't always reach it, hence this relay. It never signs or pays:
 * the wallet signs an EIP-3009 authorization locally (payee / asset / network pinned in lib/wallet/x402.ts) and the
 * signature is passed through untouched. The request body is rebuilt from validated fields the same way every time,
 * so the unpaid quote and the paid retry carry identical bodies (the quote depends on it).
 */

const UPSTREAM = "https://blockrun.ai/api/v1";

export type X402Model = {
  id: string;
  name: string;
  owner: string;
  desc: string;
  context: number | null;
  /** USD per 1M tokens */
  input: number;
  output: number;
  free: boolean;
  vision: boolean;
  reasoning: boolean;
};

let modelsCache: { at: number; v: X402Model[] } | null = null;
export async function x402Models(): Promise<X402Model[]> {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.v;
  try {
    const r = await fetch(`${UPSTREAM}/models`, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`blockrun ${r.status}`);
    const j = (await r.json()) as { data?: Record<string, unknown>[] };
    const v = (j.data ?? []).flatMap((m): X402Model[] => {
      const cats = Array.isArray(m.categories) ? (m.categories as string[]) : [];
      const p = (m.pricing ?? {}) as Record<string, unknown>;
      const free = m.billing_mode === "free";
      if (!cats.includes("chat") || m.available === false || (m.billing_mode !== "paid" && !free)) return [];
      if (typeof m.id !== "string" || (!free && (typeof p.input !== "number" || typeof p.output !== "number"))) return [];
      return [
        {
          id: m.id,
          name: typeof m.name === "string" ? m.name : m.id,
          owner: typeof m.owned_by === "string" ? m.owned_by : m.id.split("/")[0],
          desc: typeof m.description === "string" ? m.description.slice(0, 200) : "",
          context: typeof m.context_window === "number" ? m.context_window : null,
          input: free ? 0 : (p.input as number),
          output: free ? 0 : (p.output as number),
          free,
          vision: cats.includes("vision"),
          reasoning: cats.includes("reasoning"),
        },
      ];
    });
    if (!v.length) throw new Error("blockrun: no models");
    modelsCache = { at: Date.now(), v };
    return v;
  } catch (e) {
    if (modelsCache) return modelsCache.v;
    throw e;
  }
}

// per-IP budget: free models cost us nothing but BlockRun may throttle this server's IP for everyone
const WINDOW_MS = 60_000;
const PER_WINDOW = 30;
const hits = new Map<string, { at: number; n: number }>();
function allow(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > WINDOW_MS) {
    hits.set(ip, { at: now, n: 1 });
    if (hits.size > 20_000) for (const [k, v] of hits) if (now - v.at > WINDOW_MS) hits.delete(k);
    return true;
  }
  return ++h.n <= PER_WINDOW;
}

const MODEL_RE = /^[a-z0-9][\w.\-]*\/[\w.\-:+]+$/i;
const ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;
export const X402_MAX_TOKENS = 4096;

type ChatBody = { model: string; messages: { role: string; content: string }[]; max_tokens: number; temperature?: number };
function cleanBody(raw: unknown): ChatBody | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return "bad model";
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > MAX_MESSAGES) return "bad messages";
  let chars = 0;
  const messages: ChatBody["messages"] = [];
  for (const m of b.messages as Record<string, unknown>[]) {
    if (!m || typeof m.role !== "string" || !ROLES.has(m.role) || typeof m.content !== "string") return "bad message";
    chars += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (chars > MAX_CHARS) return "messages too long";
  const maxTokens = Number(b.max_tokens ?? 2048);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > X402_MAX_TOKENS) return "bad max_tokens";
  const body: ChatBody = { model: b.model, messages, max_tokens: maxTokens };
  if (b.temperature != null) {
    const tp = Number(b.temperature);
    if (!Number.isFinite(tp) || tp < 0 || tp > 2) return "bad temperature";
    body.temperature = tp;
  }
  return body;
}

const decodeB64Json = (v: string | null): Record<string, unknown> | null => {
  if (!v) return null;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * One chat completion. Without `payment` BlockRun answers free models directly and quotes paid ones with a 402
 * (body: x402Version / accepts / price; `resource` added from the PAYMENT-REQUIRED header). With `payment` (the
 * base64 x402 payload) it verifies, runs and settles; the settlement receipt comes back as `_payment`.
 */
export async function x402Chat(raw: unknown, payment: string | undefined, ip: string): Promise<{ status: number; json: unknown }> {
  if (!allow(ip)) return { status: 429, json: { error: "too many requests" } };
  const body = cleanBody(raw);
  if (typeof body === "string") return { status: 400, json: { error: body } };
  if (payment != null && (payment.length > 8_000 || !/^[A-Za-z0-9+/=]+$/.test(payment))) return { status: 400, json: { error: "bad payment header" } };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (payment) headers["PAYMENT-SIGNATURE"] = payment;
  let r: Response;
  try {
    r = await fetch(`${UPSTREAM}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(130_000) });
  } catch (e) {
    return { status: 502, json: { error: `blockrun unreachable: ${(e as Error).message}` } };
  }
  const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) return { status: 502, json: { error: `blockrun ${r.status}` } };
  if (r.status === 402) {
    const req = decodeB64Json(r.headers.get("payment-required"));
    return { status: 402, json: { ...json, resource: json.resource ?? req?.resource ?? null } };
  }
  if (r.ok) {
    return { status: 200, json: { ...json, _payment: decodeB64Json(r.headers.get("payment-response")), _settled: r.headers.get("x-payment-settled") !== "false", _served: r.headers.get("x-served-model") } };
  }
  return { status: r.status >= 500 ? 502 : r.status, json };
}
