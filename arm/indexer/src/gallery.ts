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
      await sql`insert into gallery (src, url, posted_at) values (${src}, ${`/api/uploads/${name}`}, ${p.postedAt}) on conflict (src) do nothing`;
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
