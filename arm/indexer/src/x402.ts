/**
 * 「AI 模型」 relay for the wallet: BlockRun's OpenAI-compatible gateway, paid per call in USDC on Base over x402.
 * BlockRun sends no CORS headers and mainland users can't always reach it, hence this relay. It never signs or pays:
 * the wallet signs an EIP-3009 authorization locally (payee / asset / network pinned in lib/wallet/x402.ts) and the
 * signature is passed through untouched. The request body is rebuilt from validated fields the same way every time,
 * so the unpaid quote and the paid retry carry identical bodies (the quote depends on it).
 */
import { randomUUID } from "node:crypto";

const ORIGIN = "https://blockrun.ai";
const UPSTREAM = `${ORIGIN}/api/v1`;

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
const hits = new Map<string, { at: number; n: number }>();
/** `key` is ip + bucket: calls (quote + paid retry) get 30 a minute, job / relay polls 120 */
function allow(key: string, perWindow = 30): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.at > WINDOW_MS) {
    hits.set(key, { at: now, n: 1 });
    if (hits.size > 20_000) for (const [k, v] of hits) if (now - v.at > WINDOW_MS) hits.delete(k);
    return true;
  }
  return ++h.n <= perWindow;
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

export type Relayed = { status: number; json: unknown };
const badPayment = (p: string | undefined) => p != null && (p.length > 8_000 || !/^[A-Za-z0-9+/=]+$/.test(p));

/**
 * One call to BlockRun. Without `payment` paid routes answer 402 (body: x402Version / accepts / price; `resource`
 * added from the PAYMENT-REQUIRED header). With `payment` (the base64 x402 payload) BlockRun verifies, runs and
 * settles; the settlement receipt comes back as `_payment`. 202 (async jobs) passes through with its `poll_url`.
 */
async function upstream(url: string, init: { method: "GET" | "POST"; body?: object; payment?: string; timeoutMs: number }): Promise<Relayed> {
  const headers: Record<string, string> = {};
  if (init.body) headers["content-type"] = "application/json";
  if (init.payment) {
    headers["PAYMENT-SIGNATURE"] = init.payment;
    headers["X-PAYMENT"] = init.payment;
  }
  let r: Response;
  try {
    r = await fetch(url, { method: init.method, headers, body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(init.timeoutMs) });
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
    return { status: r.status, json: { ...json, _payment: decodeB64Json(r.headers.get("payment-response")), _settled: r.headers.get("x-payment-settled") !== "false", _served: r.headers.get("x-served-model") } };
  }
  return { status: r.status >= 500 ? 502 : r.status, json };
}

/**
 * nginx cuts /api/ requests at 60s, but music and long answers take longer (and the paid call can't be redone).
 * A call still running after HANDOFF_MS is parked under a random id and answered 202 `{ relay: id }`; the wallet
 * then waits on GET /api/x402/relay/:id, which long-polls until the parked call finishes.
 */
const HANDOFF_MS = 45_000;
const parked = new Map<string, { at: number; p: Promise<Relayed>; v?: Relayed }>();
const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));
async function handoff(p: Promise<Relayed>): Promise<Relayed> {
  const v = await Promise.race([p, sleep(HANDOFF_MS)]);
  if (v) return v;
  const now = Date.now();
  for (const [k, j] of parked) if (now - j.at > 20 * 60_000) parked.delete(k);
  const id = randomUUID();
  const job: { at: number; p: Promise<Relayed>; v?: Relayed } = { at: now, p };
  void p.then((x) => (job.v = x));
  parked.set(id, job);
  return { status: 202, json: { relay: id } };
}
export async function x402Relay(id: string, ip: string): Promise<Relayed> {
  if (!allow(`${ip}:poll`, 120)) return { status: 429, json: { error: "too many requests" } };
  const job = parked.get(id);
  if (!job) return { status: 404, json: { error: "unknown or expired relay id" } };
  const v = job.v ?? (await Promise.race([job.p, sleep(25_000)]));
  return v ?? { status: 202, json: { relay: id } };
}

/** One chat completion; see `upstream` for the payment round. */
export async function x402Chat(raw: unknown, payment: string | undefined, ip: string): Promise<Relayed> {
  if (!allow(ip)) return { status: 429, json: { error: "too many requests" } };
  const body = cleanBody(raw);
  if (typeof body === "string") return { status: 400, json: { error: body } };
  if (badPayment(payment)) return { status: 400, json: { error: "bad payment header" } };
  return handoff(upstream(`${UPSTREAM}/chat/completions`, { method: "POST", body, payment, timeoutMs: 170_000 }));
}

// ---------- media: image / video / speech / music / sound effects ----------

export type MediaKind = "image" | "video" | "speech" | "music" | "sfx";
export type MediaModel = {
  id: string;
  kind: MediaKind;
  name: string;
  owner: string;
  desc: string;
  /** USD before BlockRun's 5% margin, per `unit` */
  price: number;
  unit: "image" | "second" | "1k" | "track" | "call";
  /** image: "WxH" with its own price */
  sizes?: { size: string; price: number }[];
  defSec?: number;
  maxSec?: number;
};
export type MediaVoice = { id: string; name: string; desc: string; gender: string; accent: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const getJson = async (path: string) => {
  const r = await fetch(`${UPSTREAM}${path}`, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`blockrun ${path} ${r.status}`);
  return ((await r.json()) as { data?: Record<string, unknown>[] }).data ?? [];
};
const base = (m: Record<string, unknown>, kind: MediaKind) => ({
  id: str(m.id),
  kind,
  name: str(m.name, str(m.id)),
  owner: str(m.owned_by, str(m.id).split("/")[0]),
  desc: str(m.description).slice(0, 200),
});

let mediaCache: { at: number; v: { models: MediaModel[]; voices: MediaVoice[] } } | null = null;
export async function x402Media(): Promise<{ models: MediaModel[]; voices: MediaVoice[] }> {
  if (mediaCache && Date.now() - mediaCache.at < 10 * 60_000) return mediaCache.v;
  try {
    const [images, videos, music, all, voices] = await Promise.all([getJson("/images/models"), getJson("/video/models"), getJson("/audio/models"), getJson("/models"), getJson("/audio/voices")]);
    const models: MediaModel[] = [];
    for (const m of images) {
      const p = (m.pricing ?? {}) as Record<string, unknown>;
      const sizes = (Array.isArray(p.sizes) ? (p.sizes as Record<string, unknown>[]) : []).flatMap((s) => (num(s.width) && num(s.height) && num(s.price) != null ? [{ size: `${s.width}x${s.height}`, price: num(s.price)! }] : []));
      const price = num(p.per_image);
      if (m.available !== false && price != null) models.push({ ...base(m, "image"), price, unit: "image", sizes: sizes.length ? sizes : [{ size: "1024x1024", price }] });
    }
    for (const m of videos) {
      const p = (m.pricing ?? {}) as Record<string, unknown>;
      const price = num(p.per_second);
      if (m.available !== false && price != null) models.push({ ...base(m, "video"), price, unit: "second", defSec: num(p.default_duration_seconds) ?? 5, maxSec: num(p.max_duration_seconds) ?? 10 });
    }
    for (const m of music) {
      const price = num(((m.pricing ?? {}) as Record<string, unknown>).per_track);
      if (m.available !== false && price != null) models.push({ ...base(m, "music"), price, unit: "track" });
    }
    for (const m of all) {
      const cats = Array.isArray(m.categories) ? (m.categories as string[]) : [];
      const p = (m.pricing ?? {}) as Record<string, unknown>;
      if (m.available === false) continue;
      // ElevenLabs voices only: the voice picker below lists ElevenLabs voices
      if (cats.includes("tts") && str(m.id).startsWith("elevenlabs/") && num(p.per_1k_chars) != null) models.push({ ...base(m, "speech"), price: num(p.per_1k_chars)!, unit: "1k" });
      if (cats.includes("sound_effect") && num(p.per_generation) != null) models.push({ ...base(m, "sfx"), price: num(p.per_generation)!, unit: "call" });
    }
    const vs: MediaVoice[] = voices.flatMap((v) => {
      const id = str(v.alias) || str(v.voice_id);
      const [name, desc = ""] = str(v.name, id).split(" - ");
      const l = (v.labels ?? {}) as Record<string, unknown>;
      return id ? [{ id, name, desc, gender: str(l.gender), accent: str(l.accent) }] : [];
    });
    if (!models.length) throw new Error("blockrun: no media models");
    mediaCache = { at: Date.now(), v: { models, voices: vs } };
    return mediaCache.v;
  } catch (e) {
    if (mediaCache) return mediaCache.v;
    throw e;
  }
}

const MEDIA_PATH: Record<MediaKind, string> = { image: "/images/generations", video: "/videos/generations", speech: "/audio/speech", music: "/audio/generations", sfx: "/audio/sound-effects" };

/**
 * Reference images (image → image, image → video) come from two places only: our own uploads (/api/uploads/…, see
 * api.ts) or a file BlockRun generated earlier. Video takes a public URL; image2image only takes a data URI, which
 * is built here (and cached) so the quote and the paid retry carry the same bytes.
 */
const UPLOAD_RE = /^\/api\/uploads\/([a-f0-9]{32}\.(png|jpg|webp))$/;
const BR_MEDIA = `${ORIGIN}/api/media/`;
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `https://${(process.env.PUBLIC_DOMAINS ?? "arm.yyheart.com").split(",")[0].trim()}`;
const isRef = (v: unknown): v is string => typeof v === "string" && (UPLOAD_RE.test(v) || (v.startsWith(BR_MEDIA) && MEDIA_FILE_RE.test(v.slice(BR_MEDIA.length)) && /\.(png|jpe?g|webp)$/i.test(v)));
const refUrl = (ref: string) => (ref.startsWith("/") ? `${PUBLIC_BASE}${ref}` : ref);
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const dataUris = new Map<string, string>();
async function refDataUri(ref: string): Promise<string> {
  const hit = dataUris.get(ref);
  if (hit) return hit;
  const ext = ref.split(".").pop()!.toLowerCase();
  let buf: Buffer;
  const up = UPLOAD_RE.exec(ref);
  if (up) {
    const { readFile } = await import("node:fs/promises");
    buf = await readFile(`${process.env.UPLOAD_DIR ?? "./uploads"}/${up[1]}`);
  } else {
    const r = await fetch(ref, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`reference image ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf.length > 8 * 1024 * 1024) throw new Error("reference image too large");
  const uri = `data:${MIME[ext] ?? "image/png"};base64,${buf.toString("base64")}`;
  if (dataUris.size > 40) dataUris.delete(dataUris.keys().next().value!);
  dataUris.set(ref, uri);
  return uri;
}
const MEDIA_TIMEOUT: Record<MediaKind, number> = { image: 240_000, video: 90_000, speech: 120_000, music: 330_000, sfx: 120_000 };
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

function cleanMedia(kind: MediaKind, raw: unknown): object | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const model = typeof b.model === "string" && MODEL_RE.test(b.model) ? b.model : null;
  if (kind === "sfx") {
    const t = text(b.text, 1_000);
    if (!t) return "bad text";
    const body: Record<string, unknown> = { model: model ?? "elevenlabs/sound-effects", text: t };
    if (b.duration_seconds != null) {
      const d = Number(b.duration_seconds);
      if (!Number.isFinite(d) || d < 0.5 || d > 22) return "bad duration";
      body.duration_seconds = d;
    }
    return body;
  }
  if (!model) return "bad model";
  if (kind === "speech") {
    const input = text(b.input, 5_000);
    if (!input) return "bad input";
    if (typeof b.voice !== "string" || !/^[\w-]{2,40}$/.test(b.voice)) return "bad voice";
    return { model, input, voice: b.voice, response_format: "mp3" };
  }
  const prompt = text(b.prompt, kind === "image" ? 4_000 : 2_000);
  if (!prompt) return "bad prompt";
  if (kind === "image") {
    if (b.size != null && (typeof b.size !== "string" || !/^\d{3,4}x\d{3,4}$/.test(b.size))) return "bad size";
    if (b.image != null && !isRef(b.image)) return "bad reference image";
    const body: Record<string, unknown> = { model, prompt };
    if (b.image) body.image = b.image;
    if (b.size) body.size = b.size;
    body.n = 1;
    return body;
  }
  if (kind === "video") {
    const d = Number(b.duration_seconds);
    if (!Number.isInteger(d) || d < 1 || d > 30) return "bad duration";
    if (b.image_url != null && !isRef(b.image_url)) return "bad reference image";
    return b.image_url ? { model, prompt, image_url: refUrl(b.image_url as string), duration_seconds: d } : { model, prompt, duration_seconds: d };
  }
  const instrumental = b.instrumental !== false;
  const lyrics = instrumental ? null : text(b.lyrics, 3_000);
  return lyrics ? { model, prompt, instrumental, lyrics } : { model, prompt, instrumental };
}

/**
 * ElevenLabs' sound-effect model only understands English: given 「游戏打击音效」 it voices the words instead of
 * making the sound. Chinese prompts are rewritten into an English sound description by a free chat model first
 * (cached, so the quote and the paid retry send the same text; sound effects are flat-priced either way).
 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const sfxEnglish = new Map<string, string>();
export async function sfxPrompt(text: string): Promise<string> {
  if (!CJK.test(text)) return text;
  const hit = sfxEnglish.get(text);
  if (hit) return hit;
  let free: string[] = [];
  try {
    free = (await x402Models()).filter((m) => m.free).map((m) => m.id);
  } catch {
    return text;
  }
  // Llama follows instructions best but sometimes answers in Chinese; the others are the fallback
  const order = [...free.filter((m) => m.includes("llama")), ...free.filter((m) => !m.includes("llama"))].slice(0, 3);
  for (const model of order) {
    try {
      const r = await upstream(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        body: {
          model,
          messages: [
            { role: "system", content: "You write prompts for an AI sound-effect generator. Always answer in English only. Describe only the sound itself (source, action, texture, feel) in one short line. No speech, no quotes, no explanation." },
            { role: "user", content: `Translate this sound-effect request into an English sound-effect prompt: ${text}` },
          ],
          max_tokens: 120,
          temperature: 0,
        },
        timeoutMs: 20_000,
      });
      const raw = (r.json as { choices?: { message?: { content?: string | null } }[] }).choices?.[0]?.message?.content ?? "";
      const out = (raw.split("</think>").pop() ?? "").trim().split("\n")[0].trim().replace(/^(prompt:\s*)/i, "").replace(/^["'“]+|["'”]+$/g, "").trim();
      if (r.status !== 200 || out.length < 3 || out.length > 300 || CJK.test(out)) continue;
      if (sfxEnglish.size > 300) sfxEnglish.delete(sfxEnglish.keys().next().value!);
      sfxEnglish.set(text, out);
      return out;
    } catch {
      // next model
    }
  }
  return text;
}

export const isMediaKind = (k: string): k is MediaKind => k in MEDIA_PATH;
export async function x402Generate(kind: MediaKind, raw: unknown, payment: string | undefined, ip: string): Promise<Relayed> {
  if (!allow(ip)) return { status: 429, json: { error: "too many requests" } };
  const body = cleanMedia(kind, raw);
  if (typeof body === "string") return { status: 400, json: { error: body } };
  if (badPayment(payment)) return { status: 400, json: { error: "bad payment header" } };
  let path = MEDIA_PATH[kind];
  if (kind === "sfx") (body as { text: string }).text = await sfxPrompt((body as { text: string }).text);
  const ref = (body as { image?: string }).image;
  if (kind === "image" && ref) {
    path = "/images/image2image";
    try {
      (body as { image?: string }).image = await refDataUri(ref);
    } catch (e) {
      return { status: 400, json: { error: (e as Error).message } };
    }
  }
  return handoff(upstream(`${UPSTREAM}${path}`, { method: "POST", body, payment, timeoutMs: MEDIA_TIMEOUT[kind] }));
}

/** BlockRun's own async jobs (video, slow images / music): poll with the SAME payment header; it settles on completion. */
const POLL_RE = /^\/api\/v1\/(videos|images|audio)\/generations\/[\w-]{1,400}(\?[\w\-.%=&]{0,800})?$/;
export async function x402Job(pollUrl: string | undefined, payment: string | undefined, ip: string): Promise<Relayed> {
  if (!allow(`${ip}:poll`, 120)) return { status: 429, json: { error: "too many requests" } };
  if (!pollUrl || !POLL_RE.test(pollUrl)) return { status: 400, json: { error: "bad poll url" } };
  if (badPayment(payment)) return { status: 400, json: { error: "bad payment header" } };
  return upstream(`${ORIGIN}${pollUrl}`, { method: "GET", payment, timeoutMs: 40_000 });
}

/** Generated files live under blockrun.ai/api/media/…, which mainland users can't always reach: stream them through. */
const MEDIA_FILE_RE = /^media\/[a-z]+\/\d{4}\/\d{2}\/\d{2}\/[\w\-.]{1,200}$/;
export async function x402MediaFile(path: string, range: string | undefined): Promise<Response> {
  if (!MEDIA_FILE_RE.test(path)) return new Response("bad path", { status: 400 });
  let r: Response;
  try {
    r = await fetch(`${ORIGIN}/api/media/${path}`, { headers: range ? { range } : {}, signal: AbortSignal.timeout(60_000) });
  } catch {
    return new Response("upstream unreachable", { status: 502 });
  }
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = r.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (r.ok) headers.set("cache-control", "public, max-age=604800, immutable");
  return new Response(r.body, { status: r.status, headers });
}
