// Merge string fragments into zh.json / en.json.
//   node i18n/merge-parts.mjs [dir=i18n/_parts]
// Each fragment is { "key": ["中文", "English"], ... }. A key already in zh.json with the same Chinese is reused
// silently; the same key with different Chinese is a conflict (listed, not written) — rename one of them in the code.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? join(here, "_parts");
const zh = JSON.parse(readFileSync(join(here, "zh.json"), "utf8"));
const en = JSON.parse(readFileSync(join(here, "en.json"), "utf8"));
const from = {};
let added = 0;
const conflicts = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const part = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const [k, v] of Object.entries(part)) {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") {
      conflicts.push(`${f}: ${k} is not ["中文", "English"]`);
      continue;
    }
    if (k in zh) {
      if (zh[k] !== v[0]) conflicts.push(`${k}: "${zh[k]}" (${from[k] ?? "zh.json"}) vs "${v[0]}" (${f})`);
      continue;
    }
    zh[k] = v[0];
    en[k] = v[1];
    from[k] = f;
    added++;
  }
}
writeFileSync(join(here, "zh.json"), JSON.stringify(zh, null, 2) + "\n");
writeFileSync(join(here, "en.json"), JSON.stringify(en, null, 2) + "\n");
console.log(`added ${added} keys (zh.json now ${Object.keys(zh).length})`);
if (conflicts.length) {
  console.log(`${conflicts.length} conflicts:`);
  for (const c of conflicts) console.log("  " + c);
  process.exit(1);
}
