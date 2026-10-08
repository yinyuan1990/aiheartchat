// 检查每种语言的译文包和中文原文包（tools/mark.py 生成的 zh/）是否一致：
//   缺的 key、多余的 key、{占位符} 对不上、原文里的 id="..." 在译文里丢了。
//   node i18n/tools/check.mjs        （在 site/ 目录下跑；有问题时退出码 1）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = readFileSync(join(root, 'i18n.js'), 'utf8');
const langs = [...runtime.matchAll(/\{ code: '([\w-]+)'/g)].map((m) => m[1]);

function load(file) {
  const dict = {};
  vm.runInNewContext(readFileSync(file, 'utf8'), { SiteI18n: { add: (d) => Object.assign(dict, d) } });
  return dict;
}
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const ids = (s) => [...String(s).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).sort().join(',');

let bad = 0;
const pages = readdirSync(join(root, 'zh')).filter((f) => f.endsWith('.js'));
for (const lang of langs.filter((l) => l !== 'zh')) {
  for (const page of pages) {
    const zh = load(join(root, 'zh', page));
    const file = join(root, lang, page);
    if (!existsSync(file)) { console.log(`${lang}/${page}: 缺整个文件`); bad++; continue; }
    const tr = load(file);
    const missing = Object.keys(zh).filter((k) => !(k in tr));
    const extra = Object.keys(tr).filter((k) => !(k in zh));
    const holeBad = Object.keys(zh).filter((k) => k in tr && holes(zh[k]) !== holes(tr[k]));
    const idBad = Object.keys(zh).filter((k) => k in tr && ids(zh[k]) !== ids(tr[k]));
    const n = missing.length + extra.length + holeBad.length + idBad.length;
    console.log(`${lang}/${page}: ${Object.keys(tr).length}/${Object.keys(zh).length}${n ? '' : ' OK'}`);
    for (const k of missing) console.log(`  缺   ${k}  ${zh[k].slice(0, 60)}`);
    for (const k of extra) console.log(`  多余 ${k}`);
    for (const k of holeBad) console.log(`  占位符不一致 ${k}: {${holes(zh[k])}} vs {${holes(tr[k])}}`);
    for (const k of idBad) console.log(`  id 丢了 ${k}: ${ids(zh[k])}`);
    bad += n;
  }
}
process.exit(bad ? 1 : 0);
