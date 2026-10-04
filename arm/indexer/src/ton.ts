/**
 * TON relay for the wallet: a toncenter-v2-style REST subset (the wallet builds and signs transfers itself; sendBoc
 * only forwards bytes, so the relay cannot change recipient or amount), plus jetton names / prices and the transfer
 * check for 心之音 chat cards.
 * Upstreams: Orbs TON Access nodes (toncenter v2 API, anonymous and not throttled; node list from their manager,
 * refreshed every 10 minutes), then toncenter itself — without TON_API_KEY toncenter allows ~1 request/s shared by
 * every anonymous caller, so it is only the fallback. TON_API = comma-separated bases to use instead of Orbs.
 * Jetton metadata, prices and parsed transfers come from tonapi.io (no key; cached).
 */

const ORBS_MNGR = "https://ton.access.orbs.network/mngr/nodes";
const FIXED = (process.env.TON_API ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const FALLBACK = (process.env.TON_API_FALLBACK ?? "https://toncenter.com/api/v2").replace(/\/$/, "");
const KEY = process.env.TON_API_KEY ?? "";
const TONAPI = "https://tonapi.io";

let orbs: { at: number; bases: string[] } = { at: 0, bases: [] };
let rr = 0;
async function upstreams(): Promise<string[]> {
  if (FIXED.length) return [...FIXED, FALLBACK];
  if (Date.now() - orbs.at > 600_000) {
    try {
      const r = await fetch(ORBS_MNGR, { signal: AbortSignal.timeout(8_000) });
      const list = (await r.json()) as { NodeId: string; Healthy: string; Mngr?: { health?: Record<string, boolean> } }[];
      const bases = list.filter((n) => n.Healthy === "1" && n.Mngr?.health?.["v2-mainnet"]).map((n) => `https://ton.access.orbs.network/${n.NodeId}/1/mainnet/toncenter-api-v2`);
      if (bases.length) orbs = { at: Date.now(), bases };
    } catch {
      orbs.at = Date.now() - 540_000; // try again in a minute
    }
  }
  const b = orbs.bases;
  if (!b.length) return [FALLBACK];
  rr = (rr + 1) % b.length;
  return [b[rr], b[(rr + 1) % b.length], FALLBACK];
}

const GET = new Set(["getAddressInformation", "getTransactions", "getMasterchainInfo"]);
const POST = new Set(["runGetMethod", "sendBoc", "estimateFee"]);
const TTL: Record<string, number> = { getAddressInformation: 3_000, getTransactions: 2_000, getMasterchainInfo: 2_000, runGetMethod: 4_000 };

const hits = new Map<string, { at: number; n: number }>();
const allow = (ip: string) => {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 60_000) {
    hits.set(ip, { at: now, n: 1 });
    if (hits.size > 50_000) hits.clear();
    return true;
  }
  return ++h.n <= 300;
};

type Reply = { status: number; json: unknown };
const cache = new Map<string, { at: number; v: Reply }>();

/**
 * Some backends behind Orbs answer from a state months old (an active wallet shows as never deployed, seqno 0, a
 * jetton balance of 0). Answers carry the masterchain block they were computed at: more than 100 blocks behind the
 * newest one we know (toncenter, once a minute, plus every answer) → ask the next node.
 */
let newest = 0;
function stale(json: unknown): boolean {
  const r = (json as { result?: { block_id?: { seqno?: number }; last?: { seqno?: number } } })?.result;
  const s = r?.block_id?.seqno ?? r?.last?.seqno;
  if (typeof s !== "number") return false;
  if (s > newest) newest = s;
  return newest - s > 100;
}
async function learnNewest() {
  try {
    const r = await fetch(`${FALLBACK}/getMasterchainInfo`, { headers: KEY ? { "X-API-Key": KEY } : {}, signal: AbortSignal.timeout(8_000) });
    stale(await r.json());
  } catch {}
}
void learnNewest();
setInterval(() => void learnNewest(), 60_000).unref();

/** `method` without the /api/ton/ prefix; `query` for GET methods, `body` for POST */
export async function tonRelay(method: string, http: string, query: Record<string, string>, body: unknown, ip: string): Promise<Reply> {
  const isGet = http === "GET" && GET.has(method);
  if (!isGet && !(http === "POST" && POST.has(method))) return { status: 404, json: { ok: false, error: "not allowed" } };
  if (!allow(ip)) return { status: 429, json: { ok: false, error: "rate limited" } };
  const qs = isGet ? new URLSearchParams(Object.entries(query).filter(([k]) => ["address", "limit", "lt", "hash", "to_lt", "archival"].includes(k))).toString() : "";
  const ttl = TTL[method] ?? 0;
  const key = ttl ? `${method} ${qs} ${JSON.stringify(body ?? {})}` : "";
  const hit = key ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  let last: Reply = { status: 502, json: { ok: false, error: "ton node unavailable" } };
  for (const base of await upstreams()) {
    const headers: Record<string, string> = { accept: "application/json", ...(KEY && base === FALLBACK ? { "X-API-Key": KEY } : {}) };
    try {
      const url = `${base}/${method}${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, isGet ? { headers, signal: AbortSignal.timeout(12_000) } : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000) });
      const json = (await r.json().catch(() => ({ ok: false, error: `ton ${r.status}` }))) as { ok?: boolean; error?: string; code?: number };
      last = { status: r.status, json };
      // 4xx from a node is an answer (bad address, rejected message…); 429 / 5xx / old state try the next node
      if (r.status === 429 || r.status >= 500 || stale(json)) continue;
      if (key && r.ok) {
        if (cache.size > 20_000) cache.clear();
        cache.set(key, { at: Date.now(), v: last });
      }
      return last;
    } catch (e) {
      last = { status: 502, json: { ok: false, error: (e as Error).message.slice(0, 120) } };
    }
  }
  return last;
}

// ---------- addresses ----------

function crc16(b: Uint8Array): number {
  let c = 0;
  for (const x of b) {
    c ^= x << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
/** "0:<hex>" / EQ… / UQ… → "0:<hex>" (lower case); null when malformed */
export function tonRaw(s: string): string | null {
  const t = s.trim();
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(t);
  if (raw) return `${raw[1]}:${raw[2].toLowerCase()}`;
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(t)) return null;
  const b = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (b.length !== 36 || crc16(b.subarray(0, 34)) !== b.readUInt16BE(34)) return null;
  if ((b[0] & 0x7f) !== 0x11 && (b[0] & 0x7f) !== 0x51) return null;
  const wc = b[1] === 0xff ? -1 : b[1];
  return wc === 0 || wc === -1 ? `${wc}:${b.subarray(2, 34).toString("hex")}` : null;
}

// ---------- tonapi: jetton info + prices ----------

/** tonapi without a key allows about 1 request/s per IP: one at a time, 1.1 s apart, one retry after a 429 */
let tonapiChain: Promise<unknown> = Promise.resolve();
const TONAPI_GAP = 1_100;
function tonapi<T>(path: string): Promise<{ status: number; json: T | null }> {
  const run = async () => {
    for (let i = 0; ; i++) {
      const r = await fetch(`${TONAPI}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      const text = await r.text();
      await new Promise((res) => setTimeout(res, TONAPI_GAP));
      if (r.status === 429 && i === 0) {
        await new Promise((res) => setTimeout(res, 1_500));
        continue;
      }
      let json: T | null = null;
      try {
        // TON amounts are 64-bit numbers: keep them exact
        json = JSON.parse(text.replace(/"amount":(\d+)/g, '"amount":"$1"')) as T;
      } catch {}
      return { status: r.status, json };
    }
  };
  const p = tonapiChain.then(run, run);
  tonapiChain = p.catch(() => {});
  return p;
}

export type JettonInfo = { symbol: string; name: string; decimals: number; image: string | null; verified: boolean; priceUsd: number | null; change24h: number | null };
const metaCache = new Map<string, { at: number; v: Omit<JettonInfo, "priceUsd" | "change24h"> | null }>();
/** prices of every id asked for recently, refreshed together in one tonapi call at most once a minute */
let rates: { at: number; v: Record<string, { priceUsd: number | null; change24h: number | null }> } = { at: 0, v: {} };
const rateIds = new Map<string, number>();
let ratesBusy: Promise<void> | null = null;

async function refreshRates() {
  const ids = [...rateIds.keys()].sort();
  type R = { rates?: Record<string, { prices?: { USD?: number }; diff_24h?: { USD?: string } }> };
  const r = await tonapi<R>(`/v2/rates?tokens=${encodeURIComponent(ids.join(","))}&currencies=usd`).catch(() => null);
  if (!r?.json?.rates) return;
  // tonapi answers with the ids as it likes them (TON upper case, jettons in EQ form)
  const got = Object.entries(r.json.rates).map(([k, x]) => [k.toLowerCase() === "ton" ? "ton" : tonRaw(k), x] as const);
  const v: typeof rates.v = {};
  for (const w of ids) {
    const x = got.find(([k]) => k === w)?.[1];
    const d = x?.diff_24h?.USD?.replace("−", "-").replace("%", "");
    v[w] = { priceUsd: x?.prices?.USD ?? null, change24h: d != null && Number.isFinite(Number(d)) ? Number(d) : null };
  }
  rates = { at: Date.now(), v };
}

async function jettonMeta(raw: string) {
  const hit = metaCache.get(raw);
  if (hit && Date.now() - hit.at < (hit.v ? 6 * 3600_000 : 300_000)) return hit.v;
  type M = { metadata?: { name?: string; symbol?: string; decimals?: string; image?: string }; preview?: string; verification?: string };
  const r = await tonapi<M>(`/v2/jettons/${encodeURIComponent(raw)}`).catch(() => null);
  const m = r?.json?.metadata;
  const v = r?.status === 200 && m?.symbol && r.json?.verification !== "blacklist" ? { symbol: m.symbol, name: m.name ?? m.symbol, decimals: Number(m.decimals ?? 9), image: r.json?.preview ?? m.image ?? null, verified: r.json?.verification === "whitelist" } : null;
  if (r && (r.status === 200 || r.status === 404)) metaCache.set(raw, { at: Date.now(), v });
  if (metaCache.size > 5_000) metaCache.clear();
  return v;
}

/** `ids`: "ton" and/or jetton masters (any address form); keyed by the id as given */
export async function tonJettons(ids: string[]): Promise<Record<string, JettonInfo | null>> {
  const list = [...new Set(ids)].slice(0, 30);
  const raws = list.map((id) => (id === "ton" ? "ton" : tonRaw(id)));
  const want = [...new Set(raws.filter((x): x is string => !!x))];
  for (const w of want) rateIds.set(w, Date.now());
  if (rateIds.size > 100) [...rateIds.entries()].sort((a, b) => a[1] - b[1]).slice(0, rateIds.size - 100).forEach(([k]) => rateIds.delete(k));
  if (want.length && (Date.now() - rates.at > 60_000 || !want.every((w) => w in rates.v))) {
    ratesBusy ??= refreshRates().finally(() => (ratesBusy = null));
    await ratesBusy;
  }
  const out: Record<string, JettonInfo | null> = {};
  await Promise.all(
    list.map(async (id, i) => {
      const raw = raws[i];
      if (!raw) return void (out[id] = null);
      const p = rates.v[raw] ?? { priceUsd: null, change24h: null };
      if (raw === "ton") return void (out[id] = { symbol: "TON", name: "Toncoin", decimals: 9, image: null, verified: true, ...p });
      const m = await jettonMeta(raw);
      out[id] = m ? { ...m, ...p } : null;
    }),
  );
  return out;
}

// ---------- chat transfer check ----------

type Party = { address?: string };
type TonEvent = {
  event_id?: string;
  in_progress?: boolean;
  actions?: { type?: string; status?: string; TonTransfer?: { sender?: Party; recipient?: Party; amount?: string }; JettonTransfer?: { sender?: Party; recipient?: Party; amount?: string; jetton?: { address?: string } } }[];
};

/** finished traces never change */
const events = new Map<string, TonEvent>();

/**
 * `hash` is the wallet's own transaction (the one that processed the signed external message), i.e. the root of
 * the trace: other hashes inside the same trace are refused, so one payment cannot be claimed twice.
 */
export async function verifyTon(c: { hash: string; from: string; to: string; token: string; amount: string }): Promise<{ ok: true } | { ok: false; pending?: boolean; reason: string }> {
  const hash = c.hash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "bad tx hash" };
  const from = tonRaw(c.from);
  const to = tonRaw(c.to);
  const token = c.token === "native" ? "native" : tonRaw(c.token);
  if (!from || !to || !token) return { ok: false, reason: "bad address" };
  let ev = events.get(hash);
  if (!ev) {
    const r = await tonapi<TonEvent>(`/v2/events/${hash}`);
    if (r.status === 404) return { ok: false, pending: true, reason: "not found yet" };
    if (r.status !== 200 || !r.json) return { ok: false, pending: true, reason: `tonapi ${r.status}` };
    ev = r.json;
    if (!ev.in_progress) {
      if (events.size > 2_000) events.clear();
      events.set(hash, ev);
    }
  }
  if (ev.event_id?.toLowerCase() !== hash) return { ok: false, reason: "not the wallet's own transaction" };
  if (ev.in_progress) return { ok: false, pending: true, reason: "still in progress" };
  const raw = (p?: Party) => (p?.address ? tonRaw(p.address) : null);
  const hit = (ev.actions ?? []).some((a) => {
    if (a.status !== "ok") return false;
    if (token === "native") return a.type === "TonTransfer" && raw(a.TonTransfer?.sender) === from && raw(a.TonTransfer?.recipient) === to && String(a.TonTransfer?.amount) === c.amount;
    const j = a.JettonTransfer;
    return a.type === "JettonTransfer" && raw(j?.sender) === from && raw(j?.recipient) === to && String(j?.amount) === c.amount && !!j?.jetton?.address && tonRaw(j.jetton.address) === token;
  });
  return hit ? { ok: true } : { ok: false, reason: "no matching transfer" };
}
