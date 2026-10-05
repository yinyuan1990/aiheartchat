import { EN } from './en';

/**
 * 服务端报错多语言：service 里照旧写中文（throw new BadRequestException('群不存在')），
 * 全局异常过滤器按请求头 Accept-Language 在字典里查原文换成对应语言；查不到原样返回中文。
 * 带变量的报错在字典里写成 {x} 占位（'每人最多 {n} 个机器人'），按模式匹配后把变量填回去。
 */

type Dict = Record<string, string>;
const DICTS: Record<string, Dict> = { en: EN };

const patterns = new Map<string, { re: RegExp; names: string[]; to: string }[]>();
function patternsOf(lang: string) {
  let list = patterns.get(lang);
  if (list) return list;
  list = [];
  for (const [from, to] of Object.entries(DICTS[lang] ?? {})) {
    if (!from.includes('{')) continue;
    const names: string[] = [];
    const src = from.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? (names.push(part), '(.+?)') : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))).join('');
    list.push({ re: new RegExp(`^${src}$`), names, to });
  }
  patterns.set(lang, list);
  return list;
}

/** Accept-Language → 支持的语言代码；中文或没带返回 null（不用翻译） */
export function langOf(header: string | string[] | undefined): string | null {
  const first = (Array.isArray(header) ? header[0] : header ?? '').split(',')[0].trim().toLowerCase().split('-')[0];
  return first && first !== 'zh' && DICTS[first] ? first : null;
}

export function translate(msg: string, lang: string | null): string {
  if (!lang || !msg) return msg;
  const dict = DICTS[lang];
  const hit = dict?.[msg];
  if (hit) return hit;
  for (const p of patternsOf(lang)) {
    const m = p.re.exec(msg);
    if (m) return p.names.reduce((s, n, i) => s.split(`{${n}}`).join(m[i + 1]), p.to);
  }
  return msg;
}
