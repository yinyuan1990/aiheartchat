export const PAGE = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Arm 代上架工具</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif; background: #f4f5f7; color: #111; }
  main { max-width: 860px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 16px; }
  section { background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  label { display: block; font-size: 12px; color: #555; margin: 10px 0 4px; }
  input[type=text], input[type=password], textarea { width: 100%; padding: 8px 10px; border: 1px solid #cfd3d8; border-radius: 8px; font: inherit; }
  textarea { resize: vertical; }
  .row { display: flex; gap: 10px; align-items: flex-end; }
  .row > * { flex: 1; }
  .row > .fit { flex: 0 0 auto; }
  button { padding: 8px 16px; border: 0; border-radius: 8px; background: #111; color: #fff; font: inherit; cursor: pointer; }
  button.ghost { background: #eef0f2; color: #111; }
  button:disabled { opacity: .45; cursor: default; }
  .pics { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .pic { position: relative; border: 2px solid transparent; border-radius: 8px; overflow: hidden; background: #eee; aspect-ratio: 1; }
  .pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pic.off { opacity: .3; }
  .pic.cover { border-color: #16a34a; }
  .pic .bar { position: absolute; inset: auto 4px 4px 4px; display: flex; justify-content: space-between; }
  .pic .bar button { padding: 2px 8px; font-size: 12px; background: rgba(0,0,0,.6); }
  .pic .tag { position: absolute; top: 4px; left: 4px; background: #16a34a; color: #fff; font-size: 11px; padding: 0 6px; border-radius: 4px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chips label { display: inline-flex; gap: 6px; align-items: center; margin: 0; padding: 6px 10px; border: 1px solid #cfd3d8; border-radius: 8px; color: #111; font-size: 13px; cursor: pointer; }
  .muted { color: #777; font-size: 12px; }
  .ok { color: #16a34a; }
  .err { color: #dc2626; }
  #msg { min-height: 20px; margin-top: 10px; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <h1>Arm 代上架工具</h1>
  <div class="sub">在本机抓闲鱼商品，改好价格等信息，直接上架到指定店铺地址。</div>

  <section>
    <div id="tokenBox">
      <label>管理口令（只保存在本机 <code>%USERPROFILE%\\.arm-shop-admin</code>）</label>
      <div class="row"><input id="token" type="password" placeholder="SHOP_ADMIN_TOKEN" /><button class="fit" id="saveToken">保存</button></div>
    </div>
    <div id="tokenOk" class="muted hidden">管理口令已保存 · <a href="#" id="changeToken">更换</a></div>
    <label>店铺地址（卖家钱包）</label>
    <div class="row"><input id="seller" type="text" placeholder="0x…" /><button class="fit ghost" id="check">查店铺</button></div>
    <div id="shopInfo" class="muted" style="margin-top:6px"></div>
  </section>

  <section>
    <label>闲鱼登录（工具自己的浏览器，第一次要扫码登录一次，之后一直有效）</label>
    <div class="row"><div id="loginInfo" class="muted">未打开</div><button class="fit ghost" id="login">打开浏览器登录闲鱼</button></div>
    <label>抓取方式</label>
    <div class="chips">
      <label><input type="radio" name="mode" value="browser" /> 用登录的浏览器（最稳，会弹出窗口）</label>
      <label><input type="radio" name="mode" value="auto" /> 先直连，被拦再用浏览器</label>
      <label><input type="radio" name="mode" value="direct" /> 只直连（快，不登录）</label>
    </div>
  </section>

  <section>
    <label>闲鱼分享口令 / 链接（也可以只填商品 ID）</label>
    <div class="row"><textarea id="link" rows="2" placeholder="【闲鱼】https://m.tb.cn/h.xxxx …"></textarea><button class="fit" id="read">抓取</button></div>
  </section>

  <section id="form" class="hidden">
    <label>标题（最多 60 字）</label>
    <input id="title" type="text" maxlength="60" />
    <label>文字介绍</label>
    <textarea id="body" rows="6" maxlength="2000"></textarea>
    <label>图片（点图片可以去掉 / 加回，箭头调顺序，第一张是封面）</label>
    <div id="pics" class="pics"></div>
    <div class="row">
      <div><label>价格（美元）</label><input id="price" type="text" inputmode="decimal" placeholder="10" /><div id="srcPrice" class="muted"></div></div>
      <div><label>库存（留空 = 不限）</label><input id="stock" type="text" inputmode="numeric" /></div>
    </div>
    <label>类型</label>
    <div class="chips">
      <label><input type="radio" name="kind" value="physical" checked /> 实物（买家填收货地址）</label>
      <label><input type="radio" name="kind" value="virtual" /> 虚拟（兑换码 / 链接等）</label>
    </div>
    <div id="virtualBox" class="hidden">
      <label>虚拟商品发货方式</label>
      <div class="chips">
        <label><input type="radio" name="delivery" value="manual" checked /> 手动发货</label>
        <label><input type="radio" name="delivery" value="auto" /> 付款后自动发</label>
      </div>
      <div id="autoBox" class="hidden"><label>自动发货内容（只有付过款的买家能看到）</label><textarea id="autoContent" rows="3" maxlength="2000"></textarea></div>
    </div>
    <label>收款方式（整个店铺通用，至少开一种）</label>
    <div class="chips">
      <label><input type="checkbox" id="payToken" /> <span id="payTokenText">买入等值店铺代币</span></label>
      <label><input type="checkbox" id="payUsdc" /> 直接付 USDC</label>
    </div>
    <label>状态</label>
    <div class="chips">
      <label><input type="radio" name="status" value="on" checked /> 上架</label>
      <label><input type="radio" name="status" value="off" /> 先下架（不公开）</label>
    </div>
    <div style="margin-top:16px"><button id="list">上架到这个店铺</button></div>
    <div id="msg"></div>
  </section>
</main>
<script>
const NONCE = "__NONCE__";
const $ = (id) => document.getElementById(id);
const call = async (path, body) => {
  const r = await fetch(path, body === undefined ? { headers: { "x-nonce": NONCE } } : { method: "POST", headers: { "x-nonce": NONCE, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};
const ERR = { bad_link: "没认出闲鱼链接", not_xianyu: "这个链接不是闲鱼商品", busy: "没抓到：闲鱼限制了访问，或者浏览器里要登录 / 拖滑块。处理完再点一次抓取", gone: "商品已下架或不公开", no_pictures: "图片没下载下来" };
const msg = (t, cls) => { $("msg").textContent = t; $("msg").className = cls || ""; };
let pics = [];

function showToken(has) { $("tokenBox").classList.toggle("hidden", has); $("tokenOk").classList.toggle("hidden", !has); }
async function init() {
  const c = await call("/api/config");
  showToken(c.hasToken);
  $("seller").value = c.seller || "0x6D80C00F410c448b0dc705a1D104797bA1ca160d";
  document.querySelector('input[name="mode"][value="' + c.mode + '"]').checked = true;
  checkShop();
  pollLogin();
}
document.querySelectorAll('input[name="mode"]').forEach((el) => el.onchange = () => call("/api/config", { mode: el.value }));
function showLogin(s) {
  $("loginInfo").innerHTML = !s.open ? "浏览器未打开（抓取时会自动打开）" : s.loggedIn ? '<span class="ok">已登录闲鱼' + (s.nick ? "：" + s.nick : "") + "</span>" : '<span class="err">浏览器已打开，还没登录闲鱼</span>';
}
async function pollLogin() { try { showLogin(await call("/api/login")); } catch {} setTimeout(pollLogin, 4000); }
$("login").onclick = async () => { $("login").disabled = true; try { showLogin(await call("/api/login", {})); } catch (e) { alert(e.message); } finally { $("login").disabled = false; } };
$("saveToken").onclick = async () => { const c = await call("/api/config", { token: $("token").value }); $("token").value = ""; showToken(c.hasToken); };
$("changeToken").onclick = (e) => { e.preventDefault(); showToken(false); };

let shop = null;
async function checkShop() {
  const a = $("seller").value.trim();
  shop = null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { $("shopInfo").textContent = "地址格式不对"; return; }
  $("shopInfo").textContent = "查询中…";
  try {
    const s = await call("/api/shop?addr=" + a);
    if (!s.token) { $("shopInfo").innerHTML = '<span class="err">这个地址还没开店（没选收款代币），不能上架</span>'; return; }
    shop = s;
    $("shopInfo").innerHTML = '<span class="ok">店铺收款代币 $' + s.token.symbol + '</span> · 在售 ' + s.items.on + ' 件 · 订单 ' + s.orders;
    $("payToken").checked = s.pay.token; $("payUsdc").checked = s.pay.usdc;
    $("payTokenText").textContent = "买入等值 $" + s.token.symbol;
  } catch (e) { $("shopInfo").innerHTML = '<span class="err">' + e.message + '</span>'; }
}
$("check").onclick = checkShop;
$("seller").onchange = checkShop;

function renderPics() {
  const on = pics.filter((p) => p.on);
  $("pics").innerHTML = "";
  pics.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "pic" + (p.on ? "" : " off") + (p.on && on[0] === p ? " cover" : "");
    d.innerHTML = '<img referrerpolicy="no-referrer" src="' + p.url.replace(/^http:/, "https:") + '_300x300.jpg" />' + (p.on && on[0] === p ? '<span class="tag">封面</span>' : "") + '<div class="bar"><button data-m="-1">←</button><button data-m="1">→</button></div>';
    d.querySelector("img").onclick = () => { p.on = !p.on; renderPics(); };
    d.querySelectorAll("button").forEach((b) => b.onclick = () => { const j = i + Number(b.dataset.m); if (j < 0 || j >= pics.length) return; [pics[i], pics[j]] = [pics[j], pics[i]]; renderPics(); });
    $("pics").appendChild(d);
  });
}

$("read").onclick = async () => {
  $("read").disabled = true; $("read").textContent = "抓取中…（有滑块 / 登录页就在弹出的浏览器里处理）";
  try {
    const r = await call("/api/read", { text: $("link").value });
    $("title").value = r.title; $("body").value = r.body;
    $("stock").value = r.stock == null ? "" : r.stock;
    $("srcPrice").textContent = r.priceCny ? "闲鱼标价 ¥" + r.priceCny : "";
    pics = r.pictures.map((url) => ({ url, on: true }));
    renderPics();
    $("form").classList.remove("hidden"); msg(r.via === "browser" ? "（通过登录的浏览器抓取）" : "（直连抓取）", "muted");
    $("price").focus();
  } catch (e) { alert(ERR[e.message] || e.message); }
  finally { $("read").disabled = false; $("read").textContent = "抓取"; }
};

const radio = (n) => document.querySelector('input[name="' + n + '"]:checked').value;
document.querySelectorAll('input[name="kind"], input[name="delivery"]').forEach((el) => el.onchange = () => {
  $("virtualBox").classList.toggle("hidden", radio("kind") !== "virtual");
  $("autoBox").classList.toggle("hidden", radio("kind") !== "virtual" || radio("delivery") !== "auto");
});

$("list").onclick = async () => {
  const price = Number($("price").value);
  const chosen = pics.filter((p) => p.on).map((p) => p.url);
  const kind = radio("kind");
  const delivery = kind === "virtual" ? radio("delivery") : "manual";
  const pay = { token: $("payToken").checked, usdc: $("payUsdc").checked };
  if (!shop) return msg("先填一个已开店的店铺地址", "err");
  if (!$("title").value.trim()) return msg("标题不能空", "err");
  if (!chosen.length) return msg("至少留一张图", "err");
  if (!(price >= 0.01 && price <= 10000)) return msg("价格要在 $0.01 – $10,000", "err");
  if (!pay.token && !pay.usdc) return msg("收款方式至少开一种", "err");
  if (delivery === "auto" && !$("autoContent").value.trim()) return msg("自动发货要填发货内容", "err");
  const stock = $("stock").value.trim();
  $("list").disabled = true; msg("上传图片并上架中…");
  try {
    const r = await call("/api/list", {
      seller: $("seller").value.trim(), title: $("title").value.trim(), body: $("body").value.trim(), pictures: chosen,
      priceUsd6: String(Math.round(price * 1e6)), stock: stock === "" ? null : Number(stock), status: radio("status"),
      kind, delivery, autoContent: delivery === "auto" ? $("autoContent").value.trim() : "", pay,
    });
    $("msg").innerHTML = '<span class="ok">已上架：商品 #' + r.id + '</span> · <a href="' + r.url + '" target="_blank">' + r.url + '</a>';
    checkShop();
  } catch (e) { msg(e.message, "err"); }
  finally { $("list").disabled = false; }
};
init();
</script>
</body>
</html>`;
