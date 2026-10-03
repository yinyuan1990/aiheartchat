/**
 * TRON relay for the wallet (public TRON nodes are slow or unreachable from mainland China). Only the reads the wallet
 * needs plus broadcasthex: transactions are built and signed in the wallet, this just forwards bytes.
 * Upstream: TRON_API (default PublicNode's full-node HTTP API, no key), TRON_API_FALLBACK (default TronGrid, which
 * without TRON_API_KEY allows only ~3 requests/s per server IP and then suspends it for seconds).
 */

const UP = (process.env.TRON_API ?? "https://tron-rpc.publicnode.com").replace(/\/$/, "");
const FALLBACK = (process.env.TRON_API_FALLBACK ?? "https://api.trongrid.io").replace(/\/$/, "");
const TRONGRID = "https://api.trongrid.io";
const KEY = process.env.TRON_API_KEY ?? "";
const POST = new Set([
  "wallet/getnowblock",
  "wallet/getaccount",
  "wallet/triggerconstantcontract",
  "wallet/broadcasthex",
  "wallet/gettransactioninfobyid",
  "wallet/gettransactionbyid",
  "wallet/getaccountresource",
  "wallet/getchainparameters",
]);
/** TronGrid's indexed account view (balances of every TRC20); not on plain full nodes */
const ACCOUNT = /^v1\/accounts\/T[1-9A-HJ-NP-Za-km-z]{33}$/;

const hits = new Map<string, { at: number; n: number }>();
const allow = (ip: string) => {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 60_000) {
    hits.set(ip, { at: now, n: 1 });
    if (hits.size > 50_000) hits.clear();
    return true;
  }
  return ++h.n <= 240;
};

type Reply = { status: number; json: unknown };
const cache = new Map<string, { at: number; v: Reply }>();
/** short caches absorb several wallets / tabs polling the same thing */
const TTL: Record<string, number> = {
  "wallet/getchainparameters": 600_000,
  "wallet/getnowblock": 2_000,
  "wallet/getaccount": 3_000,
  "wallet/getaccountresource": 3_000,
  "wallet/triggerconstantcontract": 3_000,
};

/** path without the /api/trx/ prefix; body for POST paths */
export async function tronRelay(path: string, method: string, body: unknown, ip: string): Promise<Reply> {
  const isGet = method === "GET" && ACCOUNT.test(path);
  if (!isGet && !(method === "POST" && POST.has(path))) return { status: 404, json: { error: "not allowed" } };
  if (!allow(ip)) return { status: 429, json: { error: "rate limited" } };
  const ttl = TTL[path] ?? 0;
  const key = ttl ? `${path} ${JSON.stringify(body ?? {})}` : "";
  const hit = key ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  let last: Reply = { status: 502, json: { error: "tron node unavailable" } };
  for (const base of isGet ? [TRONGRID, TRONGRID] : [UP, FALLBACK]) {
    const headers: Record<string, string> = { accept: "application/json", ...(KEY && base === TRONGRID ? { "TRON-PRO-API-KEY": KEY } : {}) };
    try {
      const r = await fetch(`${base}/${path}`, isGet ? { headers, signal: AbortSignal.timeout(12_000) } : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(12_000) });
      let json = await r.json().catch(() => ({ error: `tron ${r.status}` }));
      // a full block carries every transaction (hundreds of KB); the wallet only needs its id and header
      if (path === "wallet/getnowblock" && r.ok) {
        const b = json as { blockID?: string; block_header?: unknown };
        json = { blockID: b.blockID, block_header: b.block_header };
      }
      last = { status: r.ok ? 200 : r.status, json };
      if (r.status === 429 || r.status >= 500) {
        if (isGet) await new Promise((res) => setTimeout(res, 800));
        continue;
      }
      if (key && r.ok) {
        if (cache.size > 20_000) cache.clear();
        cache.set(key, { at: Date.now(), v: last });
      }
      return last;
    } catch (e) {
      last = { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
    }
  }
  return last;
}
