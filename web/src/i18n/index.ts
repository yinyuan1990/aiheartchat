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

const current = (() => {
  const c = langChoice();
  return c !== SYSTEM && c in tables ? c : systemLang();
})();

/** 当前生效的语言代码 */
export const lang = () => current;

export function setLang(code: string) {
  localStorage.setItem(KEY, code);
  location.reload();
}

/** t('me.frozen', { n: 12 }) */
export function t(key: string, args?: Record<string, string | number>): string {
  let s = tables[current]?.[key] ?? tables.zh?.[key] ?? key;
  if (args) for (const [k, v] of Object.entries(args)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
