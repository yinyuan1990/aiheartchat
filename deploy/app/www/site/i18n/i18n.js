/*
 * 官网多语言（首页 / 融资页 / 邀请页共用）。
 * 页面里写的中文就是原文；其他语言的译文在 i18n/<语言>/<页面>.js 里用 SiteI18n.add({...}) 注册。
 * 加一种语言：在 LANGS 里加一项，再照 i18n/zh/<页面>.js（tools/mark.py 生成的原文）翻一份 i18n/<code>/<页面>.js，
 * 跑 node i18n/tools/check.mjs 看有没有漏的 key。
 *
 * 页面里：<script src="i18n/i18n.js" data-page="home"></script> 放在 <head> 里（同步加载，保证正文出来前译文已就位）。
 *   data-i18n="key"        整个元素 innerHTML 换成译文（译文里可以带 <b> <br> 等）
 *   data-i18n-text="key"   只换元素里的文字（元素里还有 svg 等不能动的子节点时用）
 *   data-i18n-attr="alt:key;content:key"  换属性
 *   data-lang-switch       放语言下拉的位置
 *   脚本里：SiteI18n.t('key', '中文原文', { n: 3 })，原文里用 {n} 占位
 *   页面脚本用 SiteI18n.ready(fn) 包起来：第一次来的访客要先按 IP 定语言（异步），定了才能用 t()
 * 语言：?lang= → 选过的 → 按 IP（后端 /api/geo，大陆 / 港澳台中文，其他英文，缓存 3 天）→ 浏览器语言。
 */
(function () {
  var LANGS = [
    { code: 'zh', name: '简体中文', short: '中文', html: 'zh-CN' },
    { code: 'en', name: 'English', short: 'EN', html: 'en' },
  ];
  var SOURCE = 'zh';
  var STORE = 'site_lang';
  // 没选过语言时按访客 IP 选（大陆 / 港澳台中文，其他英文），结果缓存 3 天；查不到再看浏览器语言
  var GEO_API = 'https://api.yyheart.com/api/geo';
  var GEO_STORE = 'site_geo';
  var GEO_TTL = 3 * 86400000;
  var GEO_WAIT = 1500;

  var me = document.currentScript;
  var base = me ? me.src.replace(/[^/]*$/, '') : '';
  var page = me ? me.getAttribute('data-page') : '';
  var dict = {};

  function info(code) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i];
    return null;
  }
  function norm(code) {
    code = String(code || '').toLowerCase();
    if (info(code)) return code;
    var head = code.split(/[-_]/)[0];
    return info(head) ? head : '';
  }
  /** 已经定了的语言：地址 ?lang=（会记住）→ 访客选过的 → 按 IP 查过的（缓存 3 天）；都没有返回 '' */
  function fixedLang() {
    var q = '';
    try { q = norm(new URLSearchParams(location.search).get('lang')); } catch (e) {}
    if (q) { try { localStorage.setItem(STORE, q); } catch (e) {} return q; }
    var saved = '';
    try { saved = norm(localStorage.getItem(STORE)); } catch (e) {}
    if (saved) return saved;
    try {
      var g = JSON.parse(localStorage.getItem(GEO_STORE) || 'null');
      if (g && Date.now() - g.at < GEO_TTL && norm(g.lang)) return norm(g.lang);
    } catch (e) {}
    return '';
  }
  function browserLang() {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (var i = 0; i < list.length; i++) { var c = norm(list[i]); if (c) return c; }
    return 'en';
  }

  var root = document.documentElement;
  var fixed = fixedLang();
  var lang = fixed || browserLang();
  function setRootLang() {
    root.lang = info(lang).html;
    root.setAttribute('data-lang', lang);
  }
  setRootLang();

  // 语言定下来、语言包也加载好之后才跑的回调（页面脚本用 SiteI18n.ready 包起来）
  var isReady = false;
  var readyFns = [];
  function ready(fn) { if (isReady) fn(); else readyFns.push(fn); }
  function markReady() {
    isReady = true;
    var fns = readyFns;
    readyFns = [];
    for (var i = 0; i < fns.length; i++) { try { fns[i](); } catch (e) { setTimeout(function () { throw e; }); } }
  }

  var revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    root.classList.remove('i18n-pending');
  }

  document.write('<style>' +
    'html.i18n-pending body{visibility:hidden}' +
    '.ls{position:relative;display:inline-flex;flex-shrink:0;font-size:13px;z-index:30}' +
    '.ls-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 11px;border-radius:16px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.04);color:#d8d8e0;font:inherit;cursor:pointer;white-space:nowrap}' +
    '.ls-btn:hover,.ls.open .ls-btn{border-color:rgba(255,255,255,0.32);color:#fff}' +
    '.ls-btn svg{width:15px;height:15px;flex-shrink:0}' +
    '.ls-btn i{font-style:normal;font-size:10px;opacity:.7}' +
    '.ls-menu{display:none;position:absolute;top:calc(100% + 6px);right:0;min-width:140px;padding:5px 0;border-radius:12px;background:#1d1d25;border:1px solid rgba(255,255,255,0.1);box-shadow:0 14px 34px rgba(0,0,0,0.55)}' +
    '.ls.open .ls-menu{display:block}' +
    '.ls-menu a{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;color:#c8c8d2;cursor:pointer;white-space:nowrap;text-decoration:none}' +
    '.ls-menu a:hover{background:rgba(254,44,85,0.12);color:#fff}' +
    '.ls-menu a.on{color:#fff;font-weight:600}' +
    '.ls-menu a.on::after{content:"\\2713";color:#ff6b81}' +
    '.ls.float{position:fixed;top:calc(env(safe-area-inset-top, 0px) + 10px);right:10px;z-index:60}' +
    '.ls.float .ls-btn{background:rgba(10,10,12,0.6);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}' +
    '</style>');

  if (fixed) {
    // 语言已定：同步加载语言包，正文出来前译文已就位
    if (lang !== SOURCE && page) {
      root.classList.add('i18n-pending');
      document.write('<script src="' + base + lang + '/' + page + '.js"><\/script>');
      setTimeout(reveal, 3000);
    }
    markReady();
  } else {
    // 第一次来：先藏起正文，按 IP 定语言（最多等 GEO_WAIT），再按需加载语言包
    root.classList.add('i18n-pending');
    setTimeout(reveal, 4000);
    var decided = false;
    var decide = function (geoLang) {
      // 接口晚到（已按浏览器语言显示了）也记下来，下次打开直接用
      if (geoLang) { try { localStorage.setItem(GEO_STORE, JSON.stringify({ lang: geoLang, at: Date.now() })); } catch (e) {} }
      if (decided) return;
      decided = true;
      if (geoLang) lang = geoLang;
      setRootLang();
      if (lang === SOURCE || !page) return markReady();
      var s = document.createElement('script');
      s.src = base + lang + '/' + page + '.js';
      s.onload = s.onerror = markReady;
      document.head.appendChild(s);
    };
    setTimeout(function () { decide(''); }, GEO_WAIT);
    try {
      fetch(GEO_API, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) { var d = j && j.data ? j.data : j; decide(norm(d && d.lang)); })
        .catch(function () { decide(''); });
    } catch (e) { decide(''); }
  }

  function fill(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
  }
  function t(key, fallback, vars) {
    var s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : fallback != null ? fallback : key;
    s = fill(s, vars);
    // 英文：数字 1 后面的复数词变单数（1 photos → 1 photo，1 replies → 1 reply）
    if (lang === 'en') s = s.replace(/(^|[^\d.,])1 ([A-Za-z]+?)(ies|s)\b/g, function (m, pre, w, end) { return end === 's' && /s$/.test(w) ? m : pre + '1 ' + w + (end === 'ies' ? 'y' : ''); });
    return s;
  }
  function setText(el, value) {
    var done = false;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      n.nodeValue = done ? '' : value;
      done = true;
    }
    if (!done) el.appendChild(document.createTextNode(value));
  }

  /**
   * 把 scope（默认整页）里标记过的元素换成当前语言；中文是原文，不用换。
   * 每个元素只换一次：页面脚本之后改写的文字（如下载按钮状态）不会被再次覆盖。
   */
  function apply(scope) {
    scope = scope || document;
    if (lang !== SOURCE) {
      var els = scope.querySelectorAll('[data-i18n],[data-i18n-text],[data-i18n-attr]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i], k;
        if (el.__i18nDone) continue;
        el.__i18nDone = true;
        if ((k = el.getAttribute('data-i18n')) && dict[k] != null) el.innerHTML = dict[k];
        if ((k = el.getAttribute('data-i18n-text')) && dict[k] != null) setText(el, dict[k]);
        var attrs = el.getAttribute('data-i18n-attr');
        if (attrs) attrs.split(';').forEach(function (pair) {
          var p = pair.split(':');
          if (p.length === 2 && dict[p[1].trim()] != null) el.setAttribute(p[0].trim(), dict[p[1].trim()]);
        });
      }
    }
    mountSwitch(scope);
    if (scope === document) reveal();
  }

  function setLang(code) {
    if (!info(code) || code === lang) return;
    try { localStorage.setItem(STORE, code); } catch (e) {}
    var u = new URL(location.href);
    u.searchParams.delete('lang');
    location.replace(u.toString());
  }

  var GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';
  function buildSwitch(host) {
    if (host.getAttribute('data-ls-ready')) return;
    host.setAttribute('data-ls-ready', '1');
    host.classList.add('ls');
    var cur = info(lang);
    var items = LANGS.map(function (l) {
      return '<a data-code="' + l.code + '"' + (l.code === lang ? ' class="on"' : '') + ' lang="' + l.html + '">' + l.name + '</a>';
    }).join('');
    host.innerHTML = '<button type="button" class="ls-btn" aria-haspopup="true" aria-label="Language">' + GLOBE + '<span>' + cur.short + '</span><i>▾</i></button><div class="ls-menu">' + items + '</div>';
    host.querySelector('.ls-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      host.classList.toggle('open');
    });
    host.querySelector('.ls-menu').addEventListener('click', function (e) {
      var a = e.target.closest('[data-code]');
      if (a) setLang(a.getAttribute('data-code'));
    });
  }
  function mountSwitch(scope) {
    var hosts = (scope || document).querySelectorAll('[data-lang-switch]');
    for (var i = 0; i < hosts.length; i++) buildSwitch(hosts[i]);
  }
  /** 页面没有放 data-lang-switch 的地方时，挂一个右上角悬浮的 */
  function floatSwitch() {
    if (document.querySelector('[data-lang-switch]')) return;
    var el = document.createElement('div');
    el.setAttribute('data-lang-switch', '');
    el.className = 'float';
    document.body.appendChild(el);
    buildSwitch(el);
  }
  document.addEventListener('click', function () {
    var open = document.querySelectorAll('.ls.open');
    for (var i = 0; i < open.length; i++) open[i].classList.remove('open');
  });
  document.addEventListener('DOMContentLoaded', function () { ready(function () { apply(document); }); });

  window.SiteI18n = {
    get lang() { return lang; },
    ready: ready,
    source: SOURCE,
    langs: LANGS,
    add: function (d) { for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) dict[k] = d[k]; },
    t: t,
    apply: apply,
    setLang: setLang,
    mountSwitch: mountSwitch,
    floatSwitch: floatSwitch,
  };
})();
