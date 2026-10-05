// Every t("key") used in the apps must exist in zh.json (plus fragments in i18n/_parts while merging).
//   node i18n/check-usage.mjs          list missing keys with the files that use them; exit 1 if any
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SOURCES = [
  { dir: "android/app/src/main/java", ext: /\.kt$/, re: /\bt\(\s*"([\w.]+)"/g },
  { dir: "ios/PeiwanIos/PeiwanIos", ext: /\.swift$/, re: /\bt\(\s*"([\w.]+)"/g },
  { dir: "web/src", ext: /\.tsx?$/, re: /\bt\(\s*['"]([\w.]+)['"]/g },
];
const known = new Set(Object.keys(JSON.parse(readFileSync(join(here, "zh.json"), "utf8"))));
const parts = join(here, "_parts");
if (existsSync(parts)) for (const f of readdirSync(parts).filter((x) => x.endsWith(".json"))) for (const k of Object.keys(JSON.parse(readFileSync(join(parts, f), "utf8")))) known.add(k);

const walk = (d, ext, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(n)) out.push(p);
  }
  return out;
};
const missing = new Map();
let used = 0;
for (const s of SOURCES) {
  for (const f of walk(join(root, s.dir), s.ext)) {
    for (const m of readFileSync(f, "utf8").matchAll(s.re)) {
      used++;
      if (!known.has(m[1])) missing.set(m[1], [...(missing.get(m[1]) ?? []), relative(root, f).replace(/\\/g, "/")]);
    }
  }
}
console.log(`${used} t() calls, ${missing.size} keys missing`);
for (const [k, fs] of missing) console.log(`  ${k}  ← ${[...new Set(fs)].join(", ")}`);
process.exit(missing.size ? 1 : 0);
