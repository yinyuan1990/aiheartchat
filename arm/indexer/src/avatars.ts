import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * Default wallet avatars, painted the same way as hotspot token logos: Pollinations (Flux, free, no key, reachable from
 * HK). Everything about the picture — subject, palette, style and the Flux seed — comes from a hash of the address,
 * so two wallets get visibly different avatars and the same wallet always gets the same one. Painted once, kept on
 * disk; until then the request 404s and the client keeps its gradient dot.
 */

const DIR = `${process.env.UPLOAD_DIR ?? "./uploads"}/avatars`;
const ENABLED = (process.env.POLLINATIONS ?? "true") === "true";
const MAX_QUEUE = 200;

const SUBJECTS = [
  "fox", "cat", "owl", "panda", "koi fish", "astronaut", "robot", "dragon", "jellyfish", "penguin", "rabbit", "tiger",
  "whale", "frog", "bee", "octopus", "deer", "shiba dog", "parrot", "turtle", "lion", "unicorn", "ghost", "mushroom",
  "cactus", "planet", "rocket", "crystal", "flame spirit", "cloud", "hamster", "raccoon", "seal", "dolphin", "hedgehog",
  "phoenix", "alien", "wolf", "bear", "sloth",
];
const PALETTES = [
  "mint and teal", "coral and peach", "electric blue and violet", "gold and amber", "pink and lilac", "lime and emerald",
  "crimson and orange", "navy and cyan", "sunset orange and magenta", "pastel rainbow", "black and neon green",
  "silver and ice blue", "lavender and sky blue", "cherry red and cream", "turquoise and yellow", "chocolate and caramel",
];
const STYLES = ["flat vector mascot", "3D clay render", "kawaii sticker", "low-poly geometric", "pixel art", "glossy toy figure"];

const pick = <T>(list: T[], h: Buffer, i: number) => list[h.readUInt16BE(i) % list.length];

export const isAvatarAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
/** EVM addresses are case-insensitive, Solana ones are not. */
const keyOf = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);
const fileOf = (a: string) => `${DIR}/${createHash("sha256").update(keyOf(a)).digest("hex").slice(0, 32)}.jpg`;

function promptOf(a: string): { prompt: string; seed: number } {
  const h = createHash("sha256").update(`avatar:${keyOf(a)}`).digest();
  const subject = pick(SUBJECTS, h, 0);
  const palette = pick(PALETTES, h, 2);
  const style = pick(STYLES, h, 4);
  return {
    prompt: `Cute ${subject} avatar, ${style}, ${palette} color palette, centered head and shoulders, bold shapes, high contrast, simple plain background, no text, no letters, no watermark.`,
    seed: h.readUInt32BE(6) % 1_000_000_000,
  };
}

const queue: string[] = [];
const queued = new Set<string>();
let running = false;

async function paint(a: string) {
  const { prompt, seed } = promptOf(a);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=256&height=256&nologo=true&model=flux&seed=${seed}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { "user-agent": "Arm/1.0 (+https://arm.yyheart.com)" } });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 8_000 * (attempt + 1)));
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok || buf.length < 2000 || !/^image\//.test(type)) throw new Error(`unexpected ${res.status} ${type} ${buf.length}b`);
    await mkdir(DIR, { recursive: true });
    await writeFile(fileOf(a), buf);
    return;
  }
  throw new Error("rate limited");
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const a = queue.shift()!;
      try {
        await paint(a);
      } catch (e) {
        console.warn("[avatars]", a.slice(0, 10), (e as Error).message);
      }
      queued.delete(keyOf(a));
      await new Promise((r) => setTimeout(r, 2_000));
    }
  } finally {
    running = false;
  }
}

/** The painted avatar, or null after queueing it for painting. */
export async function walletAvatar(a: string): Promise<Buffer | null> {
  const f = fileOf(a);
  if (await stat(f).then(() => true, () => false)) return readFile(f);
  const k = keyOf(a);
  if (ENABLED && !queued.has(k) && queue.length < MAX_QUEUE) {
    queued.add(k);
    queue.push(a);
    void drain();
  }
  return null;
}
