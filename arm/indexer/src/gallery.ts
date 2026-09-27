import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sql, getSync, setSync } from "./db.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";
const SOURCE = process.env.GALLERY_SOURCE ?? "https://api.yyheart.com/api/publish/agent/gallery";
const TOKEN = process.env.GALLERY_TOKEN ?? "";
const MAX = 1000;
const HOUR = 3_600_000;

/** UTC+8 date, so "once a day" rolls over at local midnight. */
const today = () => new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);

type PoolPic = { id: number; url: string; postedAt: string };

/** Pixel size from the file header (JPEG SOF / PNG IHDR / WebP VP8 VP8L VP8X); null when unrecognised. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16(i + 5), w: u16(i + 7) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) return { w: (u16(16) << 16) | u16(18), h: (u16(20) << 16) | u16(22) };
  if (String.fromCharCode(...b.slice(8, 12)) === "WEBP" && b.length > 30) {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/** Fill w/h for rows synced before sizes were recorded. */
async function backfillSizes() {
  const { readFile } = await import("node:fs/promises");
  const rows = await sql<{ id: string; url: string }[]>`select id, url from gallery where w is null`;
  for (const r of rows) {
    const s = await readFile(`${UPLOAD_DIR}/${r.url.split("/").pop()}`).then((d) => imageSize(d)).catch(() => null);
    if (s) await sql`update gallery set w = ${s.w}, h = ${s.h} where id = ${r.id}`;
  }
}

/** Pull the pool's newest qualified pictures, copy the new ones into our uploads, keep at most MAX unpinned. */
export async function syncGallery(): Promise<{ added: number; total: number }> {
  const res = await fetch(`${SOURCE}?limit=${MAX}`, { headers: { "X-Publish-Token": TOKEN }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`source ${res.status}`);
  const body = (await res.json()) as { data?: PoolPic[] };
  const pics = body.data ?? [];
  const known = new Set((await sql<{ src: string }[]>`select src from gallery where src like 'pool:%'`).map((r) => r.src));
  await mkdir(UPLOAD_DIR, { recursive: true });
  let added = 0;
  for (const p of pics) {
    const src = `pool:${p.id}`;
    if (known.has(src)) continue;
    try {
      const r = await fetch(p.url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.jpg`;
      await writeFile(`${UPLOAD_DIR}/${name}`, buf);
      const s = imageSize(buf);
      await sql`insert into gallery (src, url, posted_at, w, h)
        values (${src}, ${`/api/uploads/${name}`}, ${p.postedAt}, ${s?.w ?? null}, ${s?.h ?? null}) on conflict (src) do nothing`;
      added++;
    } catch (e) {
      console.error("[gallery]", src, (e as Error).message);
    }
  }
  const old = await sql<{ id: string; url: string }[]>`
    select id, url from gallery where pinned = 0 order by posted_at desc, id desc offset ${MAX}`;
  if (old.length) {
    await sql`delete from gallery where id in ${sql(old.map((o) => o.id))}`;
    for (const o of old) await unlink(`${UPLOAD_DIR}/${o.url.split("/").pop()}`).catch(() => {});
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from gallery`;
  return { added, total: n };
}

/** Sync once per local day (checked hourly, and right after start). Inert without GALLERY_TOKEN. */
export function startGallery() {
  void backfillSizes().catch((e) => console.error("[gallery] sizes", e.message));
  if (!TOKEN) return;
  const tick = async () => {
    if ((await getSync("gallery_day")) === today()) return;
    const r = await syncGallery();
    await setSync("gallery_day", today());
    console.log(`[gallery] synced +${r.added}, total ${r.total}`);
  };
  const run = () => void tick().catch((e) => console.error("[gallery]", e.message));
  run();
  setInterval(run, HOUR);
}
