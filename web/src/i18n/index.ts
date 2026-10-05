/// <reference types="vite/client" />
/**
 * 界面文字多语言：locales/<语言>.json（仓库根目录 i18n/ 里维护，node i18n/sync.mjs 复制过来）。
 * 选择存在 localStorage；切换语言后整页刷新。缺的 key 显示中文。
 */
const files = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' });
const tables: Record<string, Record<string, string>> = Object.fromEntries(Object.entries(files).map(([p, t]) => [p.replace(/^.*\/|\.json$/g, ''), t]));

export const SYSTEM = 'system';
const KEY = 'pw_lang';

/** 打包进来的语言：代码 + 本语言里的名字（"简体中文"、"English"），中文排第一 */
export const languages = Object.entries(tables)
  .map(([code, t]) => ({ code, name: t['lang.name'] ?? code }))
  .sort((a, b) => (a.code === 'zh' ? -1 : b.code === 'zh' ? 1 : a.code.localeCompare(b.code)));

export function langChoice(): string {
  return localStorage.getItem(KEY) ?? SYSTEM;
}

/** 系统是中文（含繁体）就用中文，有对应语言包就用它，其它一律英文 */
function systemLang(): string {
  const sys = (navigator.language || 'zh').toLowerCase().split('-')[0];
  return sys === 'zh' ? 'zh' : sys in tables ? sys : 'en';
}

/** App 内嵌页（大厅 hall-embed）地址带 lang=xx：跟 App 当前语言走，并记住给后续页面用 */
function urlLang(): string | null {
  const q = new URLSearchParams(`${location.search.slice(1)}&${location.hash.split('?')[1] ?? ''}`);
  const l = q.get('lang');
  return l && l in tables ? l : null;
}

const current = (() => {
  const fromUrl = urlLang();
  if (fromUrl) localStorage.setItem(KEY, fromUrl);
  const c = langChoice();
  return c !== SYSTEM && c in tables ? c : systemLang();
})();

/** 当前生效的语言代码 */
export const lang = () => current;

export function setLang(code: string) {
  localStorage.setItem(KEY, code);
  location.reload();
}

/** 服务端生成、全群共用的中文（币群名 / 群公告 / 系统昵称）：按 zh.json 里的模板匹配，换成当前语言 */
const SERVER_KEYS = ['coinGroup.name', 'coinGroup.perpName', 'coinGroup.perpNotice', 'coinGroup.notice', 'coinGroup.bot'];
const serverPatterns = SERVER_KEYS.flatMap((k) => {
  const zh = tables.zh?.[k];
  if (!zh) return [];
  const names = [...zh.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const re = new RegExp(`^${zh.split(/\{\w+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)')}$`);
  return [{ k, re, names }];
});

export function serverText(s: string): string {
  if (current === 'zh' || !s.includes('群')) return s;
  for (const p of serverPatterns) {
    const m = p.re.exec(s);
    if (m) return t(p.k, Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])));
  }
  return s;
}

/** 接口返回的数据里，把上面这些服务端文字换成当前语言（中文直接原样返回） */
export function localizeServer<T>(v: T): T {
  if (current === 'zh') return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return x.length >= 3 && x.length <= 400 ? serverText(x) : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}

/** t('me.frozen', { n: 12 }) */
export function t(key: string, args?: Record<string, string | number>): string {
  let s = tables[current]?.[key] ?? tables.zh?.[key] ?? key;
  if (args) for (const [k, v] of Object.entries(args)) s = s.split(`{${k}}`).join(String(v));
  return current === 'en' && args && Object.values(args).some((v) => String(v) === '1') ? singular(s) : s;
}

/** English "1 comments" → "1 comment" (words after a bare 1; -ies → -y, -s dropped, -ss kept) */
export const singular = (s: string) => s.replace(/\b1 ([A-Za-z]*?[a-rt-zA-RT-Z])(ies|s)\b/g, (_, w: string, suf: string) => `1 ${w}${suf === 'ies' ? 'y' : ''}`);
