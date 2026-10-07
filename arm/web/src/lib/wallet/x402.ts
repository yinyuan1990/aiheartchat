import { useQuery } from "@tanstack/react-query";
import { erc20Abi, toHex, type Address, type LocalAccount } from "viem";
import { API_BASE } from "@/lib/api";
import { BASE_USDC, EARN_CHAIN } from "./earn";
import { publicClientFor } from "./chains";
import { t } from "./i18n";

/**
 * 「AI 模型」: BlockRun's chat models paid per message over x402 (HTTP 402 + an EIP-3009 USDC authorization on Base).
 * The indexer (/api/x402/*) only relays. Everything that decides where money goes is checked here before signing:
 * network, asset, payee and the amount cap — a tampered relay can at worst ask for a payment the user then refuses.
 */

export const AI_CHAIN = EARN_CHAIN;
/** BlockRun's x402 payee on Base (from its 402 quotes). If BlockRun rotates it, quotes are refused until this is updated. */
export const BLOCKRUN_PAY_TO: Address = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const NETWORK = "eip155:8453";
export const AI_MAX_TOKENS = 2048;

export type AiModel = { id: string; name: string; owner: string; desc: string; context: number | null; input: number; output: number; free: boolean; vision: boolean; reasoning: boolean };

/** shown first in the picker, in this order, when BlockRun lists them */
export const FEATURED = ["deepseek/deepseek-chat", "openai/gpt-6-luna", "google/gemini-3.8-flash", "anthropic/claude-sonnet-5.5", "qwen/qwen3.8-flash", "moonshot/kimi-k3", "xai/grok-4.7", "zai/glm-5.3-flash", "openai/gpt-6-sol", "anthropic/claude-opus-5.5"];
export const DEFAULT_MODEL = "deepseek/deepseek-chat";

export function useAiModels() {
  return useQuery({
    queryKey: ["x402", "models"],
    queryFn: async (): Promise<AiModel[]> => {
      const r = await fetch(`${API_BASE}/x402/models`);
      if (!r.ok) throw new Error(t("cw.aichat.modelsFailed"));
      return (await r.json()) as AiModel[];
    },
    staleTime: 10 * 60_000,
  });
}

export function useAiUsdc(user?: string) {
  return useQuery({
    queryKey: ["wallet", "x402-usdc", user],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: () => publicClientFor(AI_CHAIN).readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [user as Address] }),
  });
}

export type MediaKind = "image" | "video" | "speech" | "music" | "sfx";
export type Mode = "chat" | MediaKind;
/** a BlockRun async job (video) still running: resumed from here when the page is opened again */
export type PendingJob = { poll: string; sig: string; cost: string; since: number };
export type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  /** set on media prompts and results; chat history sent to the model skips these */
  kind?: MediaKind;
  urls?: string[];
  job?: PendingJob;
  model?: string;
  cost?: string;
  tx?: string | null;
  at: number;
  error?: boolean;
};
export type ChatResult = { content: string; cost: bigint; tx: string | null; model: string };

type Accept = { scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds?: number; extra?: { name?: string; version?: string } };
type Quote = { x402Version?: number; accepts?: Accept[]; resource?: unknown; error?: string; code?: string; message?: string };
type Completion = { choices?: { message?: { content?: string | null } }[]; model?: string; _payment?: { transaction?: string } | null; _served?: string | null; error?: unknown };
type Job = { status?: string; poll_url?: string; data?: { url?: string }[]; payment?: { tx_hash?: string } };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The one payment option we accept: exact USDC on Base to BlockRun. Anything else is refused before signing. */
function pickAccept(q: Quote): Accept {
  const a = q.accepts?.find((x) => x.scheme === "exact" && x.network === NETWORK && same(x.asset, BASE_USDC));
  if (!a || !/^\d+$/.test(a.amount)) throw new Error(t("cw.aichat.errQuote"));
  if (!same(a.payTo, BLOCKRUN_PAY_TO)) throw new Error(t("cw.aichat.errPayee"));
  return a;
}

async function signPayment(account: LocalAccount, q: Quote, a: Accept): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: account.address,
    to: BLOCKRUN_PAY_TO,
    value: BigInt(a.amount),
    validAfter: BigInt(now - 600),
    // video jobs settle when they finish, so their quotes ask for 600s
    validBefore: BigInt(now + Math.min(a.maxTimeoutSeconds ?? 300, 900)),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: { name: a.extra?.name ?? "USD Coin", version: a.extra?.version ?? "2", chainId: AI_CHAIN.chain.id, verifyingContract: BASE_USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  const payload = {
    x402Version: q.x402Version ?? 2,
    resource: q.resource ?? { url: "https://blockrun.ai/api/v1/chat/completions", mimeType: "application/json" },
    accepted: a,
    payload: {
      signature,
      authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() },
    },
  };
  return btoa(JSON.stringify(payload));
}

type Res = { status: number; json: Quote & Completion & Job & { relay?: string } };
async function call(path: string, body?: object, payment?: string): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (payment) headers["x-payment-signature"] = payment;
  const once = async (p: string, b?: object): Promise<Res> => {
    const r = await fetch(`${API_BASE}${p}`, { method: b ? "POST" : "GET", headers, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: ((await r.json().catch(() => null)) ?? {}) as Res["json"] };
  };
  let res = await once(path, body);
  // the relay parks calls that outlive nginx's 60s; wait on it (each GET long-polls ~25s)
  const relay = res.status === 202 ? res.json.relay : undefined;
  for (let i = 0; relay && res.status === 202 && res.json.relay && i < 40; i++) {
    try {
      res = await once(`/x402/relay/${relay}`);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return res;
}
const post = (body: object, payment?: string) => call("/x402/chat", body, payment);

const errText = (j: Quote & Completion, status: number) => {
  if (j.code === "PAYMENT_UNFUNDED") return t("cw.aichat.errUnfunded");
  if (j.code?.startsWith("PAYMENT_")) return t("cw.aichat.errPayment", { code: j.code });
  if (status === 429) return t("cw.aichat.errBusy");
  const e = j.error;
  const msg = typeof e === "string" ? e : (e as { message?: string } | undefined)?.message;
  return msg || j.message || `HTTP ${status}`;
};

/**
 * Send one chat turn. Free models answer straight away; paid ones come back with a quote, which is signed without
 * asking when it is within `autoCap` (micro-USDC) and otherwise only after `confirm(amount)` resolves true.
 * Returns null when the user declines.
 */
export async function aiChat(
  account: () => LocalAccount,
  model: string,
  history: { role: "user" | "assistant"; content: string }[],
  autoCap: bigint,
  confirm: (amount: bigint) => Promise<boolean>,
): Promise<ChatResult | null> {
  const body = { model, messages: history, max_tokens: AI_MAX_TOKENS };
  let res = await post(body);
  let cost = 0n;
  if (res.status === 402) {
    const a = pickAccept(res.json);
    cost = BigInt(a.amount);
    if (cost > autoCap && !(await confirm(cost))) return null;
    res = await post(body, await signPayment(account(), res.json, a));
    if (res.status === 402) throw new Error(errText(res.json, 402));
  }
  if (res.status !== 200) throw new Error(errText(res.json, res.status));
  const content = res.json.choices?.[0]?.message?.content ?? "";
  return { content: content.trim() || t("cw.aichat.empty"), cost, tx: res.json._payment?.transaction ?? null, model: res.json._served || res.json.model || model };
}

// ---------- media ----------

export type MediaModel = {
  id: string;
  kind: MediaKind;
  name: string;
  owner: string;
  desc: string;
  price: number;
  unit: "image" | "second" | "1k" | "track" | "call";
  sizes?: { size: string; price: number }[];
  defSec?: number;
  maxSec?: number;
};
export type MediaVoice = { id: string; name: string; desc: string; gender: string; accent: string };

export function useAiMedia() {
  return useQuery({
    queryKey: ["x402", "media-models"],
    queryFn: async (): Promise<{ models: MediaModel[]; voices: MediaVoice[] }> => {
      const r = await fetch(`${API_BASE}/x402/media-models`);
      if (!r.ok) throw new Error(t("cw.aichat.modelsFailed"));
      return (await r.json()) as { models: MediaModel[]; voices: MediaVoice[] };
    },
    staleTime: 10 * 60_000,
  });
}

export const DEFAULT_MEDIA: Record<MediaKind, string> = {
  image: "xai/grok-imagine-image",
  video: "xai/grok-imagine-video",
  speech: "elevenlabs/flash-v2.5",
  music: "minimax/music-2.5+",
  sfx: "elevenlabs/sound-effects",
};
/** Sora only takes 4 / 8 / 12s; the others any whole second up to their max */
export const videoDurations = (m?: MediaModel) => (m?.id.startsWith("azure/sora") ? [4, 8, 12] : [5, 8, 10, 15].filter((s) => s <= (m?.maxSec ?? 10)));

/** generated files sit on blockrun.ai, which mainland users can't always reach: show them through the relay */
const MEDIA_ORIGIN = "https://blockrun.ai/api/media/";
export const mediaSrc = (url: string) => (url.startsWith(MEDIA_ORIGIN) ? `${API_BASE}/x402/media/${url.slice(MEDIA_ORIGIN.length)}` : url);

export type MediaResult = { urls: string[]; cost: bigint; tx: string | null };
const done = (j: Job & Completion, cost: bigint): MediaResult => {
  const urls = (j.data ?? []).flatMap((d) => (d.url ? [d.url] : []));
  if (!urls.length) throw new Error(t("cw.aichat.genEmpty"));
  return { urls, cost, tx: j._payment?.transaction ?? j.payment?.tx_hash ?? null };
};

/**
 * Poll a BlockRun job with the same payment header until it finishes; it settles on the first completed poll.
 * If the authorization expires mid-way the job asks again (402): re-signed once more only for no more than the
 * amount already approved.
 */
export async function pollJob(account: () => LocalAccount, job: PendingJob, onSig?: (sig: string) => void, alive: () => boolean = () => true): Promise<MediaResult> {
  let sig = job.sig;
  let resigns = 2;
  let errors = 0;
  const path = `/x402/job?u=${encodeURIComponent(job.poll)}`;
  while (alive() && Date.now() - job.since < 20 * 60_000) {
    await new Promise((r) => setTimeout(r, 5000));
    let res: Res;
    try {
      res = await call(path, undefined, sig);
    } catch {
      if (++errors > 12) throw new Error(t("cw.aichat.genLost"));
      continue;
    }
    const s = res.json.status;
    if (res.status === 200 && (s === "completed" || res.json.data?.length)) return done(res.json, BigInt(job.cost));
    if (s === "failed") throw new Error(t("cw.aichat.genFailed", { e: errText(res.json, res.status) }));
    if (res.status === 202 || s === "queued" || s === "in_progress" || res.status === 502 || res.status === 504 || res.status === 429) continue;
    if (res.status === 402 && resigns-- > 0) {
      const q = await call(path);
      if (q.status !== 402) continue;
      const a = pickAccept(q.json);
      if (BigInt(a.amount) > BigInt(job.cost)) throw new Error(t("cw.aichat.errQuote"));
      sig = await signPayment(account(), q.json, a);
      onSig?.(sig);
      continue;
    }
    throw new Error(t("cw.aichat.genFailed", { e: errText(res.json, res.status) }));
  }
  throw new Error(t("cw.aichat.genLost"));
}

/**
 * One paid generation. Same quote → cap / confirm → sign round as chat. Synchronous kinds return the files; a job
 * (video) is reported through `onJob` (so the page can keep it across reloads) and then polled to the end.
 */
export async function aiGenerate(
  account: () => LocalAccount,
  kind: MediaKind,
  body: object,
  autoCap: bigint,
  confirm: (amount: bigint) => Promise<boolean>,
  onJob: (job: PendingJob) => void,
): Promise<MediaResult | null> {
  const path = `/x402/gen/${kind}`;
  let res = await call(path, body);
  if (res.status !== 402) throw new Error(errText(res.json, res.status));
  const a = pickAccept(res.json);
  const cost = BigInt(a.amount);
  if (cost > autoCap && !(await confirm(cost))) return null;
  const sig = await signPayment(account(), res.json, a);
  res = await call(path, body, sig);
  if (res.status === 402) throw new Error(errText(res.json, 402));
  if (res.status === 202 && res.json.poll_url) {
    const job = { poll: res.json.poll_url, sig, cost: cost.toString(), since: Date.now() };
    onJob(job);
    return pollJob(account, job);
  }
  if (res.status !== 200) throw new Error(t("cw.aichat.genFailed", { e: errText(res.json, res.status) }));
  return done(res.json, cost);
}

/** Conversation + spend, kept on this device per wallet address. */
export type MediaOpts = { size?: string; sec?: number; voice?: string; instrumental?: boolean; sfxSec?: number };
export type ChatStore = { model: string; messages: ChatMsg[]; spent: string; autoCap: string; mode: Mode; picks: Partial<Record<MediaKind, string>>; opts: MediaOpts };
const storeKey = (addr: string) => `arm-aichat:${addr.toLowerCase()}`;
export const DEFAULT_CAP = 50_000n;
export function loadChat(addr: string): ChatStore {
  const empty: ChatStore = { model: DEFAULT_MODEL, messages: [], spent: "0", autoCap: DEFAULT_CAP.toString(), mode: "chat", picks: {}, opts: {} };
  try {
    const s = JSON.parse(localStorage.getItem(storeKey(addr)) ?? "null") as Partial<ChatStore> | null;
    if (s && Array.isArray(s.messages)) return { ...empty, ...s, model: s.model || DEFAULT_MODEL, spent: s.spent || "0", autoCap: s.autoCap ?? empty.autoCap, picks: s.picks ?? {}, opts: s.opts ?? {} } as ChatStore;
  } catch {}
  return empty;
}
export function saveChat(addr: string, s: ChatStore) {
  try {
    localStorage.setItem(storeKey(addr), JSON.stringify({ ...s, messages: s.messages.slice(-80) }));
  } catch {}
}

/** USD per 1M tokens → a short label */
export const perM = (v: number) => (v === 0 ? "0" : v < 0.1 ? v.toFixed(3).replace(/0+$/, "") : v < 10 ? v.toFixed(2).replace(/\.?0+$/, "") : v.toFixed(0));
/** micro-USDC → "$0.0021" */
export const usd6 = (v: bigint | string) => {
  const n = Number(v) / 1e6;
  return `$${n === 0 ? "0" : n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
};
