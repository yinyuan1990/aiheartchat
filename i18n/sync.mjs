// App UI strings, one JSON per language (zh.json is the source of truth for keys).
//   node i18n/sync.mjs          check every language against zh.json, then copy them into Android / iOS / Web
// New language: add xx.json (with "lang.name" in that language) — the apps list every file they ship.
// Placeholders are {name}; a translation must use the same set as zh.json. Missing keys fall back to Chinese.
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const TARGETS = [
  { dir: "android/app/src/main/assets/i18n", name: (l) => `${l}.json` },
  // iOS synchronized group: every file here is bundled; unique names in case they land flat in the bundle root
  { dir: "ios/PeiwanIos/PeiwanIos/i18n", name: (l) => `i18n_${l}.json` },
  { dir: "web/src/i18n/locales", name: (l) => `${l}.json` },
  // Arm wallet (opened inside the App): imports zh / en explicitly in lib/wallet/i18n.ts — add new languages there too
  { dir: "arm/web/src/lib/wallet/locales", name: (l) => `${l}.json` },
];

const langs = readdirSync(here).filter((f) => /^[a-z]{2}(-[A-Za-z]+)?\.json$/.test(f)).map((f) => f.slice(0, -5));
const load = (l) => JSON.parse(readFileSync(join(here, `${l}.json`), "utf8"));
const zh = load("zh");
const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
let bad = 0;
for (const l of langs) {
  const t = load(l);
  if (!t["lang.name"]) (bad++, console.log(`${l}: missing "lang.name"`));
  const missing = Object.keys(zh).filter((k) => !(k in t));
  const extra = Object.keys(t).filter((k) => !(k in zh));
  const wrong = Object.keys(t).filter((k) => k in zh && holes(t[k]) !== holes(zh[k]));
  if (extra.length) (bad++, console.log(`${l}: keys not in zh.json: ${extra.join(", ")}`));
  if (wrong.length) (bad++, console.log(`${l}: placeholders differ from zh.json: ${wrong.join(", ")}`));
  console.log(`${l}: ${Object.keys(t).length} keys${missing.length ? `, ${missing.length} untranslated (shown in Chinese): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}` : ""}`);
}
if (bad) process.exit(1);
for (const tg of TARGETS) {
  mkdirSync(join(root, tg.dir), { recursive: true });
  for (const l of langs) copyFileSync(join(here, `${l}.json`), join(root, tg.dir, tg.name(l)));
}
console.log(`copied ${langs.join(", ")} → ${TARGETS.map((t) => t.dir).join(", ")}`);
