import { AiError, analyze, ping, readLimits } from "./analyze.js";
import { account, assets, isAddress } from "./hl.js";

/** The wallet's manual 「AI 合约」 mode: the key arrives in `x-ai-key`, is used for this one call and never stored or logged. */

type Reply = { status: number; json: unknown };

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
const analyzeLimit = limiter(20);
const testLimit = limiter(10);

const aiOf = (b: Record<string, unknown>, key: string | undefined) => ({ provider: String(b.provider ?? ""), model: String(b.model ?? "").slice(0, 100), key: key ?? "", baseUrl: b.baseUrl ? String(b.baseUrl).slice(0, 300) : undefined });
const fail = (e: unknown): Reply => ({ status: e instanceof AiError && e.fatal ? 400 : 502, json: { error: (e as Error).message } });

export async function aiTest(body: unknown, key: string | undefined, ip: string): Promise<Reply> {
  if (!testLimit(ip)) return { status: 429, json: { error: "请求太频繁，稍后再试" } };
  try {
    const r = await ping(aiOf((body ?? {}) as Record<string, unknown>, key));
    return { status: 200, json: { ok: true, model: r.model } };
  } catch (e) {
    return fail(e);
  }
}

export async function aiAnalyze(body: unknown, key: string | undefined, ip: string): Promise<Reply> {
  if (!analyzeLimit(ip)) return { status: 429, json: { error: "请求太频繁，稍后再试" } };
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const asset = (await assets()).find((a) => a.name === b.coin);
    if (!asset) return { status: 400, json: { error: "没有这个合约" } };
    const acct = isAddress(b.user) ? await account(b.user).catch(() => null) : null;
    const { atr1h: _, ...r } = await analyze({ ...aiOf(b, key), ...readLimits(b) }, asset, acct, "manual");
    return { status: 200, json: r };
  } catch (e) {
    return fail(e);
  }
}
