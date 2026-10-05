// List every Chinese exception message in src/ (static strings and template literals → {name} placeholders),
// and which of them src/i18n/en.ts does not translate yet.
//   node scripts/extract-errors.mjs [out.json]      (run in houduan/)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".ts") && !p.includes(`${join("src", "i18n")}`)) out.push(p);
  }
  return out;
};
const han = /[\u4e00-\u9fff]/;
const found = new Map();
const re = /Exception\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
for (const f of walk("src")) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(re)) {
    let msg = m[2];
    if (!han.test(msg)) continue;
    if (m[1] === "`") {
      let i = 0;
      const names = [];
      msg = msg.replace(/\$\{([^}]*)\}/g, (_, expr) => {
        const base = (expr.match(/([A-Za-z_]\w*)\s*(?:\)|\?|$|\.|\s)/)?.[1] ?? "v").replace(/^(this|Math|String|Number)$/, "v");
        let name = base.length > 12 || /^[A-Z]/.test(base) && base === base.toUpperCase() ? `v${i}` : base;
        while (names.includes(name)) name = `${name}${i}`;
        names.push(name);
        i++;
        return `{${name}}`;
      });
    }
    msg = msg.replace(/\\'/g, "'").replace(/\\"/g, '"');
    found.set(msg, [...(found.get(msg) ?? []), f.replace(/\\/g, "/")]);
  }
}
const en = readFileSync("src/i18n/en.ts", "utf8");
const done = new Set([...en.matchAll(/^\s*(?:'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"|([^\s:'"]+))\s*:/gm)].map((m) => (m[1] ?? m[2] ?? m[3]).replace(/\\'/g, "'")));
const todo = [...found.keys()].filter((k) => !done.has(k));
console.log(`${found.size} distinct messages, ${todo.length} not in en.ts`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(todo.map((k) => [k, ""])), null, 1));
