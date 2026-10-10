import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * 闲鱼一键导入 (10.10). The seller pastes a Xianyu share text / link (m.tb.cn short link, goofish.com item page, or the
 * bare item id); we read the listing through the mtop API the Xianyu H5 page itself uses — no login: the first call
 * hands out the `_m_h5_tk` cookie and the request is then signed with it — copy its pictures into our uploads and give
 * back title / description / pictures for the item form. The price is left to the seller (we only show Xianyu's in ¥).
 */

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";
const MAX_UPLOAD = 1024 * 1024;
const APP_KEY = "12574478";
const DETAIL_API = "mtop.taobao.idle.awesome.detail";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SHORT_HOSTS = /^(m\.tb\.cn|tb\.cn)$/;
const ITEM_HOSTS = /(^|\.)(goofish\.com|2\.taobao\.com|xianyu\.taobao\.com)$/;

export type Imported = { source: "xianyu"; itemId: string; title: string; body: string; images: string[]; priceCny: string | null; stock: number | null };

/** `code` goes to the client, which shows it as shop.import.err.<code> */
export class ImportError extends Error {
  constructor(readonly code: "bad_link" | "not_xianyu" | "busy" | "gone" | "no_pictures", detail = "") {
    super(detail || code);
  }
}

const cookies = new Map<string, string>();
const done = new Map<string, { at: number; r: Imported }>();
const CACHE_MS = 6 * 3600_000;
/** Xianyu answers RGV587 (slider captcha) when it throttles our IP; asking again only keeps us blocked longer */
let blockedUntil = 0;
const BLOCK_MS = 10 * 60_000;
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function itemIdOf(text: string): Promise<string> {
  const bare = text.trim().match(/^\d{9,16}$/);
  if (bare) return bare[0];
  for (const raw of text.match(/https?:\/\/[^\s<>"'，。！】【）（]+/g) ?? []) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (ITEM_HOSTS.test(u.hostname)) {
      const id = u.searchParams.get("itemId") ?? u.searchParams.get("id");
      if (id && /^\d{6,20}$/.test(id)) return id;
    }
    if (SHORT_HOSTS.test(u.hostname)) {
      // the short link answers with a tiny page that sets `var url = '<goofish item url>'` and jumps there in JS
      const html = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(() => "");
      const target = html.match(/var url = '([^']+)'/)?.[1] ?? "";
      const id = target.match(/[?&](?:itemId|id)=(\d{6,20})/)?.[1];
      if (id && /goofish\.com|2\.taobao\.com/.test(target)) return id;
      if (target) throw new ImportError("not_xianyu");
    }
  }
  throw new ImportError("bad_link");
}

async function mtop<T>(api: string, data: Record<string, unknown>): Promise<T> {
  if (Date.now() < blockedUntil) throw new ImportError("busy");
  const body = JSON.stringify(data);
  for (let i = 0; i < 3; i++) {
    const tk = cookies.get("_m_h5_tk")?.split("_")[0] ?? "";
    const t = Date.now();
    const sign = createHash("md5").update(`${tk}&${t}&${APP_KEY}&${body}`).digest("hex");
    const url = `https://h5api.m.goofish.com/h5/${api}/1.0/?jsv=2.7.2&appKey=${APP_KEY}&t=${t}&sign=${sign}&v=1.0&type=originaljson&accountSite=xianyu&dataType=json&timeout=20000&api=${api}&data=${encodeURIComponent(body)}`;
    const r = await fetch(url, {
      headers: { "user-agent": UA, cookie: cookieHeader(), referer: "https://h5.m.goofish.com/", origin: "https://h5.m.goofish.com", "accept-language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(15_000),
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const at = kv.indexOf("=");
      if (at > 0) cookies.set(kv.slice(0, at).trim(), kv.slice(at + 1).trim());
    }
    const j = (await r.json().catch(() => null)) as { ret?: string[]; data?: T } | null;
    const ret = j?.ret?.[0] ?? `HTTP ${r.status}`;
    if (ret.startsWith("SUCCESS")) return j!.data as T;
    if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/.test(ret)) continue;
    if (/RGV587|USER_VALIDATE|FLOW_LIMIT/.test(ret)) {
      blockedUntil = Date.now() + BLOCK_MS;
      cookies.clear();
      throw new ImportError("busy", ret);
    }
    if (/ITEM_NOT_FOUND|NOT_EXIST|DELETED|OFFLINE/i.test(ret)) throw new ImportError("gone", ret);
    throw new Error(`xianyu ${ret}`);
  }
  throw new ImportError("busy", "token loop");
}

function sniff(buf: Uint8Array) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";
  return null;
}

/** alicdn resizes on the fly: ask for ≤1280px webp first (fits the 1 MB upload cap), the original as a fallback */
async function copyPicture(src: string): Promise<string | null> {
  const u = src.replace(/^\/\//, "https://").replace(/^http:/, "https:");
  if (!/^https:\/\/[a-z0-9.-]+\.alicdn\.com\//.test(u)) return null;
  for (const v of [`${u}_1280x1280q85.jpg_.webp`, u]) {
    const buf = await fetch(v, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) })
      .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
      .catch(() => null);
    const ext = buf && buf.length <= MAX_UPLOAD ? sniff(buf) : null;
    if (!buf || !ext) continue;
    const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    // names are content hashes: an existing file is this very picture (imported before)
    await writeFile(`${UPLOAD_DIR}/${name}`, buf, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    return `/api/uploads/${name}`;
  }
  return null;
}

type ItemDO = { title?: string; desc?: string; imageInfos?: { url?: string }[]; soldPrice?: string; quantity?: number };

export async function importXianyu(text: string): Promise<Imported> {
  const itemId = await itemIdOf(text);
  const hit = done.get(itemId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.r;
  const data = await mtop<{ itemDO?: ItemDO }>(DETAIL_API, { itemId });
  const it = data.itemDO;
  if (!it?.title && !it?.desc) throw new ImportError("gone");
  const lines = (it.desc ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim());
  let title = (it.title ?? lines.find(Boolean) ?? "").trim();
  // Xianyu cuts auto titles at 30 characters of the description's first line: take the whole line when it fits
  if (lines[0] && lines[0] !== title && lines[0].startsWith(title) && [...lines[0]].length <= 60) title = lines[0];
  // Xianyu's title is usually just the description's first line: don't say it twice
  if (lines[0] === title && lines.slice(1).some(Boolean)) lines.shift();
  // "59.9发一包…": a leading ¥ price contradicts the dollar price set here
  const lead = title.match(/^[¥￥]?(\d+(?:\.\d+)?)(?:元|块)?\s*/);
  if (lead && Number(lead[1]) === Number(it.soldPrice) && title.length > lead[0].length + 4) title = title.slice(lead[0].length);
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
  const pics = (it.imageInfos ?? []).map((x) => x.url).filter((u): u is string => !!u).slice(0, 9);
  const images = (await Promise.all(pics.map((u) => copyPicture(u).catch((e) => (console.error("[shop] import picture", (e as Error).message), null))))).filter((u): u is string => !!u);
  if (!images.length) throw new ImportError("no_pictures");
  const stock = Number(it.quantity);
  const r: Imported = {
    source: "xianyu",
    itemId,
    title: [...title].slice(0, 60).join(""),
    body,
    images,
    priceCny: it.soldPrice ?? null,
    stock: Number.isInteger(stock) && stock > 1 ? stock : null,
  };
  for (const [k, v] of done) if (Date.now() - v.at > CACHE_MS) done.delete(k);
  done.set(itemId, { at: Date.now(), r });
  return r;
}
