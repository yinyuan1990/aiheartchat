import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Turns a trending topic into a ready-to-launch token identity. Radar v2: runs when the first user clicks Launch on
 * a hotspot (plus a small pre-generated daily top), then is cached on the row — one generation per hotspot, bounded
 * by `aiDailyCap`, never per click.
 *
 *  - copy  : OpenAI chat (gpt-4o-mini, JSON mode). Without OPENAI_API_KEY a deterministic template is used.
 *  - logo  : OpenAI images (gpt-image-1, low quality, 1024²) saved into UPLOAD_DIR like a user upload.
 *            Without a key (or on failure) an SVG monogram is written instead — the launch never blocks on art.
 */

export type Ideas = {
  /** English identity — the default that goes on-chain */
  name: string;
  symbol: string;
  description: string;
  logoPrompt: string;
  /** Chinese identity (OpenAI path only); the UI shows it to zh users and can put it on-chain instead */
  nameZh?: string;
  descriptionZh?: string;
  /** the trend title in the other language (zh topics → titleEn, en topics → titleZh) */
  titleZh?: string;
  titleEn?: string;
  /** which path produced it — surfaced in /admin so the owner sees when the fallback is running */
  by: "openai" | "openrouter" | "template";
};

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";
/** only used as the OpenRouter referer; the first public domain */
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `https://${(process.env.PUBLIC_DOMAINS ?? "arm.yyheart.com").split(",")[0].trim()}`;

/**
 * Providers. The server sits in Hong Kong, which OpenAI (and Gemini) geo-block, so the primary path is
 *   - text : OpenRouter (OpenAI-compatible chat endpoint, routes to the same gpt-4o-mini) — OPENROUTER_API_KEY
 *   - image: fal.ai Flux (schnell) — FAL_KEY
 * A direct OpenAI key still works when set (e.g. after moving the box to a supported region).
 */
const OPENAI = process.env.OPENAI_API_KEY;
const OPENAI_BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENROUTER = process.env.OPENROUTER_API_KEY;
/** Arm: DeepSeek's own API for text only (images stay on the keyless Pollinations path). */
const DEEPSEEK = process.env.DEEPSEEK_API_KEY;
const FAL = process.env.FAL_KEY;
// Via OpenRouter the OpenAI / Google / Anthropic endpoints still refuse Hong Kong ("not available in your region"),
// so the routed default is DeepSeek V3 — strong in both English and Chinese, served by non-geo-blocked providers.
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL ?? (OPENAI ? "gpt-4o-mini" : DEEPSEEK ? "deepseek-chat" : "deepseek/deepseek-chat-v3-0324");
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
const FAL_MODEL = process.env.FAL_MODEL ?? "fal-ai/flux/schnell";
/** OpenRouter image-capable chat model (returns the picture as a data-URL in message.images) */
const OR_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image";

/** Text endpoint + headers for whichever chat provider is configured (OpenAI first, then OpenRouter). */
function chatEndpoint(): { url: string; headers: Record<string, string> } | null {
  if (OPENAI) return { url: `${OPENAI_BASE}/chat/completions`, headers: { authorization: `Bearer ${OPENAI}` } };
  if (DEEPSEEK) return { url: "https://api.deepseek.com/v1/chat/completions", headers: { authorization: `Bearer ${DEEPSEEK}` } };
  if (OPENROUTER) return { url: "https://openrouter.ai/api/v1/chat/completions", headers: { authorization: `Bearer ${OPENROUTER}`, "http-referer": PUBLIC_BASE, "x-title": "Arm" } };
  return null;
}

export const aiAvailable = () => !!(OPENAI || DEEPSEEK || OPENROUTER);
// DeepSeek speaks the same OpenAI-compatible protocol, so it reports as "openai" to the rest of the pipeline
export const textProvider = () => (OPENAI || DEEPSEEK ? "openai" : OPENROUTER ? "openrouter" : "template");
/** Free keyless Flux endpoint; on by default, disable with POLLINATIONS=false. */
const POLLINATIONS = (process.env.POLLINATIONS ?? "true") === "true";
export const imageProvider = () => (OPENAI ? "openai" : FAL ? "fal" : POLLINATIONS ? "pollinations" : OPENROUTER ? "openrouter" : "monogram");

// ------------------------------------------------------------------ safety classifier (layer 2)

/** Optional content tag shown on the card and used by the 内容标签 filter; `none` = untagged. */
export type MemeCategory = "animal" | "food" | "quote" | "abstract" | "scene" | "trend" | "nickname" | "none";
export const MEME_CATEGORIES: MemeCategory[] = ["animal", "food", "quote", "abstract", "scene", "trend", "nickname"];

/** Boss spec 9.10 §6: the AI only sorts what the local rules could not decide into four buckets. No scores. */
export type Verdict = "SAFE" | "POLITICS" | "TRAGEDY" | "LOW_QUALITY";
export type SafetyVerdict = { verdict: Verdict; category: MemeCategory; by: "openai" | "openrouter" | "none" };

/**
 * One batched call classifies 30-50 titles. ~1k tokens in, ~0.4k out → well under a cent on DeepSeek. Results are
 * cached forever by normalized title (hotspot_verdicts), so a title is never paid for twice. Without an AI key every
 * title is SAFE / untagged (the local rules already removed the dangerous material).
 */
export async function classifySafety(topics: { title: string; lang?: "en" | "zh"; context: string[] }[]): Promise<SafetyVerdict[]> {
  const fallback = topics.map<SafetyVerdict>(() => ({ verdict: "SAFE", category: "none", by: "none" }));
  const ep = chatEndpoint();
  if (!ep || topics.length === 0) return fallback;
  const sys = [
    "You moderate trending topics and posts for a light-hearted meme launchpad. For EACH input line output exactly one verdict:",
    "SAFE = fun / neutral internet culture, entertainment, animals, food, slang, catchphrases, viral clips, games, sports banter, products, celebrities' harmless antics, harmless jokes about public figures.",
    "POLITICS = elections, governments, policy, politicians acting as politicians, geopolitics, war, activism, ideology, religion-as-politics.",
    "TRAGEDY = death, disasters, accidents, crime with victims, disease, violence, missing persons, grief.",
    "LOW_QUALITY = spam, ads, giveaways, token shilling, bare links, unintelligible fragments, generic chatter with no topic.",
    "Do NOT write explanations or scores. Titles may be Chinese or English.",
    "Also give a content tag: animal (动物), food (食物), quote (金句 / catchphrase), abstract (抽象热词 / slang), scene (魔性场面 / viral moment), trend (趣味风潮 / challenge / fashion), nickname (二创外号 / fan nickname), or none.",
    "Return STRICT JSON: {\"items\":[{\"i\":<index>,\"v\":\"SAFE|POLITICS|TRAGEDY|LOW_QUALITY\",\"c\":\"<tag>\"}]} with one entry per input index, nothing else.",
  ].join(" ");
  const user = topics.map((t, i) => `${i}. ${t.title}${t.context[0] ? ` — ${t.context[0].slice(0, 100)}` : ""}`).join("\n");
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...ep.headers },
      body: JSON.stringify({ model: TEXT_MODEL, temperature: 0.1, max_tokens: 30 * topics.length + 100, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (j.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(raw) as { items?: { i?: number; v?: string; c?: string }[] } | { i?: number; v?: string; c?: string }[];
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    const out = [...fallback];
    const by = OPENAI ? "openai" : "openrouter";
    for (const it of items) {
      const i = Number(it.i);
      if (!Number.isInteger(i) || i < 0 || i >= topics.length) continue;
      const v = String(it.v ?? "").toUpperCase() as Verdict;
      const c = String(it.c ?? "").toLowerCase() as MemeCategory;
      out[i] = { verdict: ["SAFE", "POLITICS", "TRAGEDY", "LOW_QUALITY"].includes(v) ? v : "SAFE", category: MEME_CATEGORIES.includes(c) ? c : "none", by };
    }
    return out;
  } catch (e) {
    console.warn("[radar:ai] safety classify failed, passing batch as SAFE:", (e as Error).message);
    return fallback;
  }
}

// ------------------------------------------------------------------ copy

const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,6}$/;

/**
 * @param topic.source  a trend source id ("x" / "tiktok" / "google") — or "user" when the creator typed the name
 *                      themselves on the create page; in that case the name is kept verbatim and only symbol /
 *                      description / logo are produced.
 */
type Topic = { title: string; source: string; context: string[]; lang?: "en" | "zh"; /** X handle when source = "xuser" */ account?: string };

export async function generateIdeas(topic: Topic): Promise<Ideas> {
  if (chatEndpoint()) {
    try {
      const out = await openaiIdeas(topic);
      if (out) return out;
    } catch (e) {
      console.warn("[hotspots:ai] copy failed, using template:", (e as Error).message);
    }
  }
  const tpl = templateIdeas(topic);
  return topic.source === "user" ? { ...tpl, name: topic.title.trim().slice(0, 32), nameZh: undefined } : tpl;
}

async function openaiIdeas(topic: Topic): Promise<Ideas | null> {
  const fromUser = topic.source === "user";
  const fromAccount = topic.source === "xuser" && topic.account;
  const topicLang = topic.lang ?? "en";
  const sys = [
    "You name meme tokens for a Uniswap V3 launchpad on the Arc blockchain (USDC-native). The audience is bilingual (English + Simplified Chinese).",
    fromUser
      ? "The creator already chose the token NAME — return it unchanged as `name`."
      : fromAccount
        ? `Given a fresh post by @${topic.account} on X, invent a meme token identity that riffs on what the post says (a phrase, a joke, an image in it). Do not use the poster's real name as the token name.`
        : "Given a trending topic, invent a token identity.",
    "Return STRICT JSON with exactly these keys: name, symbol, description, logoPrompt, name_zh, description_zh, title_zh, title_en.",
    fromUser ? "symbol: 3-6 uppercase letters/digits derived from the name, no '$'." : "name: catchy ENGLISH name, 3-24 chars, Title Case, no emoji, no '$'. symbol: 3-6 uppercase ASCII letters/digits, no '$'.",
    "description: ENGLISH, one or two sentences, max 180 chars, playful meme tone, no financial promises, no hashtags.",
    "name_zh: a natural Simplified-Chinese token name (2-10 characters) with the same spirit; description_zh: Simplified-Chinese version of the description, max 80 characters.",
    `title_zh / title_en: the trending topic itself rendered in Simplified Chinese / English (the topic is given in ${topicLang === "zh" ? "Chinese" : "English"}; copy that side verbatim and translate the other).`,
    "logoPrompt: a short English prompt for a flat vector-style circular token logo that fits the name (no text in the image).",
    fromUser ? "" : "Avoid real people's full names as the token name if the topic is a person; use a playful nickname instead.",
    fromUser ? "" : "Pure meme energy only: lean into the animal / food / catchphrase / absurd angle of the topic; never reference news, politics, tragedy or anything serious even if the source topic touches it. The name must be understandable in 3 seconds with no backstory (1-3 English words), visual enough to draw as a cartoon sticker, and never an official brand / trademark or a real person's full name.",
  ].filter(Boolean).join(" ");
  const user = fromUser
    ? `Token name chosen by the creator: "${topic.title}"`
    : fromAccount
      ? `Post by @${topic.account} on X: "${topic.title}"\n\nFull post / quoted post:\n${topic.context.map((c) => `- ${c}`).join("\n") || "- (none)"}`
      : `Trending on ${topic.source}: "${topic.title}"\n\nContext:\n${topic.context.map((c) => `- ${c}`).join("\n") || "- (none)"}`;
  const ep = chatEndpoint();
  if (!ep) return null;
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...ep.headers },
    body: JSON.stringify({ model: TEXT_MODEL, temperature: 0.9, max_tokens: 400, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  let raw = j.choices?.[0]?.message?.content;
  if (!raw) {
    console.warn("[hotspots:ai] empty completion:", JSON.stringify(j).slice(0, 300));
    return null;
  }
  // some routed models wrap JSON in a ```json fence despite json_object mode
  raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const p = JSON.parse(raw) as Partial<Ideas> & { name_zh?: string; description_zh?: string; title_zh?: string; title_en?: string };
  const name = fromUser ? topic.title.trim().slice(0, 32) : String(p.name ?? "").replace(/[$#]/g, "").trim().slice(0, 24);
  let symbol = String(p.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (!SYMBOL_RE.test(symbol)) symbol = symbolFrom(name || topic.title);
  const description = String(p.description ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (name.length < 2 || description.length < 10) {
    console.warn("[hotspots:ai] rejected completion (name/description too short):", raw.slice(0, 300));
    return null;
  }
  // boss rule: a followed person's real name is never the token name (nicknames / phrases only)
  if (fromAccount && /elon musk|cathie wood|changpeng|michael saylor|bill ackman|donald trump|\bmusk\b|\bsaylor\b|\backman\b|\btrump\b/i.test(name)) {
    console.warn("[hotspots:ai] rejected completion (real name used):", name);
    return null;
  }
  const clean = (v: unknown, max: number) => { const s = String(v ?? "").replace(/[$#]/g, "").replace(/\s+/g, " ").trim().slice(0, max); return s.length >= 1 ? s : undefined; };
  return {
    name, symbol, description,
    logoPrompt: String(p.logoPrompt ?? "").slice(0, 300) || `flat vector circular logo about ${topic.title}`,
    nameZh: clean(p.name_zh, 24),
    descriptionZh: clean(p.description_zh, 120),
    titleZh: topicLang === "zh" ? topic.title : clean(p.title_zh, 80),
    titleEn: topicLang === "en" ? topic.title : clean(p.title_en, 80),
    by: OPENAI ? "openai" : "openrouter",
  };
}

const SRC_NAME: Record<string, [string, string]> = { x: ["X", "X"], xuser: ["X", "X"], tiktok: ["TikTok", "TikTok"], google: ["Google", "Google 热搜"], weibo: ["Weibo", "微博热搜"] };

export function templateIdeas(topic: Topic): Ideas {
  const clean = topic.title.replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const isZh = topic.lang === "zh" || /[\u4e00-\u9fff]/.test(clean);
  const latinName = (clean.split(" ").map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Hot Topic").slice(0, 24);
  // a Chinese topic keeps its own characters as the name; the symbol must still be ASCII
  const name = isZh ? clean.slice(0, 24) || "热点" : latinName;
  const [srcEn, srcZh] = topic.source === "xuser" && topic.account ? [`@${topic.account}'s feed`, `@${topic.account} 的推文`] : (SRC_NAME[topic.source] ?? [topic.source, topic.source]);
  const descEn = topic.source === "user"
    ? `${name} — a community meme token launched on Arc, settled in USDC. Fair launch, LP locked forever.`
    : `${name} is trending on ${srcEn} right now. A community meme token launched on Arc, settled in USDC.`;
  const descZh = topic.source === "user"
    ? `${name} —— 发射在 Arc 上、以 USDC 结算的社区 meme 代币。公平发射，LP 永久锁定。`
    : `「${name}」正在${srcZh}上升温。发射在 Arc 上、以 USDC 结算的社区 meme 代币。`;
  return {
    name,
    symbol: symbolFrom(clean || "HOT"),
    description: descEn.slice(0, 180),
    logoPrompt: `flat vector circular logo about ${clean}`,
    nameZh: isZh ? name : undefined,
    descriptionZh: descZh.slice(0, 120),
    titleZh: isZh ? topic.title : undefined,
    titleEn: isZh ? undefined : topic.title,
    by: "template",
  };
}

/** 3–6 uppercase ASCII chars: initials of Latin words; for non-Latin titles a deterministic 4-letter code. */
export function symbolFrom(title: string): string {
  const words = title.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const latin = words.join("");
  if (latin.length < 2) {
    // no usable Latin letters (e.g. a Chinese headline): hash the title into consonants so it is stable and unique-ish
    const hex = createHash("sha1").update(title).digest("hex");
    const letters = "BCDFGHJKLMNPQRSTVWXZ";
    return Array.from({ length: 4 }, (_, i) => letters[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % letters.length]).join("");
  }
  let s = words.map((w) => w[0]).join("");
  if (s.length < 3) s = (words[0] ?? "HOT").slice(0, 5);
  s = s.slice(0, 6);
  if (!/^[A-Z]/.test(s)) s = "H" + s.slice(0, 5);
  while (s.length < 3) s += "X";
  return s;
}

// ------------------------------------------------------------------ logo

const LOGO_STYLE = "Centered, bold shapes, high contrast, crypto token logo style, flat vector, plain background, no text, no letters, no watermark.";

export async function generateLogo(ideas: Ideas, seed: string): Promise<{ url: string; by: "openai" | "fal" | "pollinations" | "openrouter" | "monogram" }> {
  const prompt = `${ideas.logoPrompt}. ${LOGO_STYLE}`;
  // Pollinations (Flux, free, no key, reachable from HK). Seeded from the hotspot so re-runs are stable.
  if (POLLINATIONS && !OPENAI && !FAL) {
    const seedNum = parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 6), 16);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&model=flux&seed=${seedNum}`;
    // the free tier rate-limits bursts (429): back off and retry a few times before giving up
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { "user-agent": "Arm/1.0 (+https://arm.yyheart.com)" } });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 8_000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`${res.status}`);
        const type = res.headers.get("content-type") ?? "";
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > 2000 && /^image\//.test(type)) return { url: await store(buf, type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"), by: "pollinations" };
        throw new Error(`unexpected response ${type} ${buf.length}b`);
      } catch (e) {
        console.warn("[hotspots:ai] pollinations logo failed:", (e as Error).message);
        break;
      }
    }
  }
  // fal.ai Flux — reachable from Hong Kong, ~$0.003 per image
  if (FAL && !OPENAI) {
    try {
      const res = await fetch(`https://fal.run/${FAL_MODEL}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Key ${FAL}` },
        body: JSON.stringify({ prompt, image_size: "square", num_images: 1, num_inference_steps: 4, enable_safety_checker: true }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { images?: { url?: string }[] };
      const url = j.images?.[0]?.url;
      if (url) {
        const buf = new Uint8Array(await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
        if (buf.length > 0) return { url: await store(buf, "png"), by: "fal" };
      }
    } catch (e) {
      console.warn("[hotspots:ai] fal logo failed, using monogram:", (e as Error).message);
    }
  }
  // OpenRouter image-capable chat model (Gemini 2.5 Flash Image) — lets one crypto-funded account cover copy AND
  // logos. The image comes back inline as a data: URL on the assistant message.
  // Off by default: every image model on OpenRouter is Google/OpenAI-hosted and refuses Hong Kong. Enable with
  // OPENROUTER_IMAGE=true once the box moves to a supported region.
  if (OPENROUTER && !OPENAI && !FAL && process.env.OPENROUTER_IMAGE === "true") {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPENROUTER}`, "http-referer": PUBLIC_BASE, "x-title": "Arm" },
        body: JSON.stringify({
          model: OR_IMAGE_MODEL,
          modalities: ["image", "text"],
          messages: [{ role: "user", content: `Generate one square image: ${prompt}` }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] };
      const dataUrl = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (dataUrl) {
        const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
        let buf: Uint8Array | null = null;
        if (m) buf = new Uint8Array(Buffer.from(m[2], "base64"));
        else if (/^https?:/.test(dataUrl)) buf = new Uint8Array(await (await fetch(dataUrl, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
        if (buf && buf.length > 0) return { url: await store(buf, m?.[1] === "jpeg" || m?.[1] === "jpg" ? "jpg" : m?.[1] === "webp" ? "webp" : "png"), by: "openrouter" };
      }
      throw new Error("no image in response");
    } catch (e) {
      console.warn("[hotspots:ai] openrouter logo failed, using monogram:", (e as Error).message);
    }
  }
  if (OPENAI) {
    try {
      const res = await fetch(`${OPENAI_BASE}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI}` },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: "1024x1024", quality: "low", n: 1 }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const d = j.data?.[0];
      let buf: Uint8Array | null = null;
      if (d?.b64_json) buf = new Uint8Array(Buffer.from(d.b64_json, "base64"));
      else if (d?.url) buf = new Uint8Array(await (await fetch(d.url)).arrayBuffer());
      if (buf && buf.length > 0) return { url: await store(buf, "png"), by: "openai" };
    } catch (e) {
      console.warn("[hotspots:ai] logo failed, using monogram:", (e as Error).message);
    }
  }
  return { url: await monogramLogo(ideas.symbol, seed), by: "monogram" };
}

/** Instant keyless fallback picture (used when a launcher confirms without any logo). */
export const monogramLogo = (symbol: string, seed: string) => store(new TextEncoder().encode(monogramSvg(symbol, seed)), "svg");

async function store(buf: Uint8Array, ext: "png" | "jpg" | "webp" | "svg"): Promise<string> {
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(`${UPLOAD_DIR}/${name}`, buf);
  // host-relative: the site lives on several domains at once (see api.ts "domains"); the frontend resolves it
  return `/api/uploads/${name}`;
}

/** Two-letter monogram on a deterministic gradient — same look as the frontend's fallback avatars. */
export function monogramSvg(symbol: string, seed: string): string {
  const h = parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 6), 16) % 360;
  const txt = symbol.slice(0, 2).replace(/[<>&]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 70% 55%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 70% 40%)"/></linearGradient></defs>
<circle cx="128" cy="128" r="128" fill="url(#g)"/>
<text x="128" y="150" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="112" fill="#fff" letter-spacing="-4">${txt}</text>
</svg>`;
}
