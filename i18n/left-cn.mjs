// Chinese string literals still in app code (comments skipped), to review what was left on purpose.
//   node i18n/left-cn.mjs [out.txt]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  ["android/app/src/main/java", /\.kt$/],
  ["ios/PeiwanIos/PeiwanIos", /\.swift$/],
  ["web/src", /\.tsx?$/],
  ["arm/web/src/app/wallet", /\.tsx?$/],
  ["arm/web/src/components/wallet", /\.tsx?$/],
  ["arm/web/src/lib/wallet", /\.tsx?$/],
];
const SKIP = /cities\.ts$/;
const walk = (d, ext, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(n) && !SKIP.test(n)) out.push(p);
  }
  return out;
};
const lit = /(["'`])((?:(?!\1)[^\\]|\\.)*?[\u4e00-\u9fff](?:(?!\1)[^\\]|\\.)*?)\1/;
// JSX text between tags: <h1>中文</h1>, or a line of bare text inside JSX
const jsx = />([^<>{}]*[\u4e00-\u9fff][^<>{}]*)(<|$)|^([^<>{}"'`=;()]*[\u4e00-\u9fff][^<>{}"'`=;()]*)$/;
const out = [];
const only = process.argv[3];
for (const [d, ext] of SOURCES) {
  if (only && !d.startsWith(only)) continue;
  for (const f of walk(join(root, d), ext)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const s = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(s)) return;
      const code = s.replace(/\s\/\/.*$/, "");
      const m = code.match(lit);
      const j = !m && /\.tsx$/.test(f) ? code.match(jsx) : null;
      if (m || j) out.push(`${relative(root, f).replace(/\\/g, "/")}:${i + 1}: ${(m ? m[2] : (j[1] ?? j[3])).trim().slice(0, 60)}`);
    });
  }
}
writeFileSync(process.argv[2] ?? join(root, "i18n/_left.txt"), out.join("\n") + "\n");
console.log(`${out.length} lines with Chinese literals`);
