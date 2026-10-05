// Look up existing keys by Chinese text, so the same sentence reuses one key across platforms.
//   node i18n/find-key.mjs "清空聊天记录" "发送失败" ...     exact matches (also matches templates: "冻结 12" finds "冻结 {n}")
//   node i18n/find-key.mjs --like 语音房                     every key whose Chinese contains the text
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const zh = JSON.parse(readFileSync(join(here, "zh.json"), "utf8"));
const en = JSON.parse(readFileSync(join(here, "en.json"), "utf8"));
const args = process.argv.slice(2);
const like = args[0] === "--like";
const show = (k) => `  ${k} = ${JSON.stringify(zh[k])} / ${JSON.stringify(en[k] ?? "")}`;
const tpl = Object.keys(zh).filter((k) => zh[k].includes("{")).map((k) => ({ k, re: new RegExp(`^${zh[k].split(/\{\w+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)")}$`) }));
for (const q of like ? args.slice(1) : args) {
  const hits = like ? Object.keys(zh).filter((k) => zh[k].includes(q)) : [...Object.keys(zh).filter((k) => zh[k] === q), ...tpl.filter((x) => x.re.test(q)).map((x) => x.k)];
  console.log(`${q}:${hits.length ? "" : " (none)"}`);
  for (const k of [...new Set(hits)].slice(0, 15)) console.log(show(k));
}
