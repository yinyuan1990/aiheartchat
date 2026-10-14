// Every language has every key of zh.json with the same {placeholders}, and every key the UI uses exists in zh.json.
// Adding a language = adding i18n/<code>.json (with "lang.name") and importing it in src/main.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dirname;
const zh = JSON.parse(readFileSync(join(dir, "zh.json"), "utf8"));
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
let bad = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "zh.json")) {
  const l = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const k of Object.keys(zh)) {
    if (!(k in l)) (bad++, console.log(`${f}: missing ${k}`));
    else if (ph(l[k]) !== ph(zh[k])) (bad++, console.log(`${f}: ${k} placeholders {${ph(l[k])}} vs zh {${ph(zh[k])}}`));
  }
  for (const k of Object.keys(l)) if (!(k in zh)) (bad++, console.log(`${f}: ${k} is not in zh.json`));
}
const pageSrc = readFileSync(join(dir, "../src/page.mjs"), "utf8");
const used = new Set([...pageSrc.matchAll(/data-tp?="([\w.]+)"/g), ...pageSrc.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]));
for (const k of used) if (!(k in zh)) (bad++, console.log(`page.mjs uses ${k}, not in zh.json`));
console.log(bad ? `${bad} i18n problem(s)` : `i18n ok: ${Object.keys(zh).length} keys, ${used.size} used by the page`);
process.exit(bad ? 1 : 0);
