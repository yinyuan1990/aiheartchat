#!/usr/bin/env node
/**
 * 心之音 AI 模型 · 本地选择界面（打开模型选择.bat）：选 Cursor 里 heartchat-x402 MCP 的默认模型、改上限、直接试问、看每笔花费。
 * Only on 127.0.0.1, with a per-run nonce + Host check so other web pages can't spend from the wallet. Port 47402
 * (a random one when taken).
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { account, balance, chat, config, footer, history, ledger, models, saveConfig, usd } from "./lib.mjs";

const NONCE = randomBytes(16).toString("hex");
let HOST = "";
const FEATURED = ["deepseek/deepseek-chat", "anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-sol", "openai/gpt-6-luna", "google/gemini-3.8-flash", "xai/grok-4.7", "moonshot/kimi-k3", "qwen/qwen3.8-flash", "zai/glm-5.3-flash"];

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readJson = async (req) => {
  let s = "";
  for await (const ch of req) s += ch;
  return s ? JSON.parse(s) : {};
};

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(PAGE.replace("__NONCE__", NONCE).replace("__FEATURED__", JSON.stringify(FEATURED)));
  }
  if (req.headers.host !== HOST || req.headers["x-nonce"] !== NONCE) return send(res, 403, { error: "forbidden" });
  if (url.pathname === "/api/state") {
    const c = config(), l = ledger();
    let bal = null;
    try { bal = await balance(); } catch {}
    return send(res, 200, { address: account?.address ?? null, balance: bal, spent: l.spent, calls: l.calls, ...c, history: history(40) });
  }
  if (url.pathname === "/api/models") return send(res, 200, await models());
  if (url.pathname === "/api/cursor") {
    // the server-side Cursor custom-model log (needs the key saved in cursor-proxy.json)
    try {
      const c = JSON.parse(readFileSync(join(homedir(), ".arm-x402-test", "cursor-proxy.json"), "utf8"));
      const r = await fetch(`${c.baseUrl}/stats?limit=200`, { headers: { authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20_000) });
      return send(res, r.status, await r.json());
    } catch (e) {
      return send(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (url.pathname === "/api/config" && req.method === "POST") {
    const b = await readJson(req), patch = {};
    if (typeof b.defaultModel === "string") patch.defaultModel = b.defaultModel;
    if (Number(b.maxPerCall) > 0 && Number(b.maxPerCall) <= 5) patch.maxPerCall = Number(b.maxPerCall);
    if (Number(b.dailyCap) > 0 && Number(b.dailyCap) <= 1000) patch.dailyCap = Number(b.dailyCap);
    return send(res, 200, saveConfig(patch));
  }
  if (url.pathname === "/api/chat" && req.method === "POST") {
    const b = await readJson(req);
    try {
      const r = await chat(String(b.model || ""), [{ role: "user", content: String(b.prompt ?? "") }], Math.min(4096, Math.max(1, Number(b.max_tokens) || 1024)), "ui");
      return send(res, 200, { ...r, footer: footer(r), costText: r.cost ? usd(r.cost) : "免费" });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => route(req, res).catch((e) => send(res, 500, { error: e.message })));
const listen = (port) => server.listen(port, "127.0.0.1");
server.on("error", (e) => { if (e.code === "EADDRINUSE") listen(0); else throw e; });
server.on("listening", () => {
  HOST = `127.0.0.1:${server.address().port}`;
  console.log(`HeartChat AI models: http://${HOST}/   (close this window to quit)`);
  if (!process.env.X402_UI_NO_OPEN) spawn("cmd", ["/c", "start", "", `http://${HOST}/`], { detached: true, stdio: "ignore" }).unref();
});
listen(47402);

const PAGE = /* html */ `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>心之音 AI 模型 · Cursor</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;background:#0f1218;color:#e7e9ee}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:14px 20px;background:#161b24;border-bottom:1px solid #232a36}
h1{font-size:17px;margin:0 12px 0 0}.chip{background:#1f2633;border:1px solid #2b3445;border-radius:10px;padding:6px 12px}
.chip b{color:#fff}.muted{color:#8b94a7;font-size:12px}main{display:grid;grid-template-columns:minmax(380px,1fr) minmax(420px,1fr);gap:16px;padding:16px 20px}
section{background:#161b24;border:1px solid #232a36;border-radius:14px;padding:14px;min-width:0}h2{font-size:14px;margin:0 0 10px}
input,textarea,select{background:#0f1218;color:#e7e9ee;border:1px solid #2b3445;border-radius:8px;padding:7px 10px;font:inherit}
textarea{width:100%;resize:vertical}button{background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer}
button.ghost{background:#232a36;color:#cfd5e1}button:disabled{opacity:.5;cursor:default}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.filters button{padding:4px 10px;font-size:12px}.filters button.on{background:#3b82f6}
.list{max-height:calc(100vh - 230px);overflow:auto}.row{display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;cursor:pointer;border:1px solid transparent}
.row:hover{background:#1c2230}.row.sel{border-color:#3b82f6;background:#18213a}.row .id{font-family:Consolas,monospace;font-size:13px;color:#fff}
.row .p{margin-left:auto;text-align:right;font-family:Consolas,monospace;font-size:12px;color:#9fb0cc;white-space:nowrap}
.tag{font-size:11px;border-radius:6px;padding:0 6px;margin-left:6px}.t-def{background:#16a34a;color:#fff}.t-free{background:#0e7490;color:#fff}.t-r{background:#6d28d9;color:#fff}
.ans{white-space:pre-wrap;background:#0f1218;border:1px solid #232a36;border-radius:10px;padding:12px;margin-top:10px;max-height:46vh;overflow:auto}
.foot{font-size:12px;color:#9fb0cc;margin-top:6px;word-break:break-all}.warn{color:#fbbf24}.err{color:#f87171}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:5px 6px;border-bottom:1px solid #232a36;text-align:left;vertical-align:top}th{color:#8b94a7;font-weight:500}
a{color:#7cb4ff}
</style></head><body>
<header>
  <h1>心之音 AI 模型 · Cursor</h1>
  <div class="chip">钱包 <b id="addr">…</b></div>
  <div class="chip">余额 <b id="bal">…</b> USDC</div>
  <div class="chip">今天 <b id="spent">…</b></div>
  <div class="chip">默认模型 <b id="def">…</b></div>
  <div class="chip">单条上限 $<input id="cap1" size="4"> · 每天 $<input id="cap2" size="4"> <button class="ghost" id="saveCaps">保存</button></div>
</header>
<main>
  <section>
    <h2>选模型 <span class="muted">（点一行选中；「设为默认」后，Cursor 里不写模型名就用它）</span></h2>
    <input id="q" placeholder="搜索：claude / gpt / deepseek / grok / qwen…" style="width:100%">
    <div class="filters" id="filters"></div>
    <div class="list" id="list">加载中…</div>
  </section>
  <section>
    <h2>试一下 <span class="muted" id="selName"></span></h2>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <button id="setDef">设为 Cursor 默认模型</button>
      <span class="muted">最长回复</span><select id="mt"><option>256</option><option>512</option><option selected>1024</option><option>2048</option><option>4096</option></select>
      <span class="muted" id="est"></span>
    </div>
    <textarea id="prompt" rows="5" placeholder="问点什么，比如：你是哪家公司的什么模型？知识截止到什么时候？"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px"><button id="ask">发送</button><button class="ghost" id="probe">验货问题</button></div>
    <div id="out"></div>
    <h2 style="margin-top:16px">调用记录 <span class="muted">（MCP 和这个界面的，记在本机）</span></h2>
    <div style="max-height:30vh;overflow:auto"><table><thead><tr><th>时间</th><th>来源</th><th>选的模型 → 实际服务</th><th>tokens</th><th>花费</th><th>交易</th></tr></thead><tbody id="hist"></tbody></table></div>
  </section>
  <section style="grid-column:1/-1">
    <h2>Cursor 自定义模型明细 <span class="muted">（Cursor 设置里填我们 Base URL 后的每次请求，记在服务器；10.12 13:50 之前的没有 token 数）</span> <button class="ghost" id="cRefresh">刷新</button></h2>
    <div id="cSum" class="muted"></div>
    <h2 style="margin-top:12px;font-size:13px">按天 · 按模型</h2>
    <div style="max-height:24vh;overflow:auto"><table><thead><tr><th>日期</th><th>模型</th><th>次数</th><th>输入 tokens</th><th>输出 tokens</th><th>花费</th><th>平均每次</th></tr></thead><tbody id="cDays"></tbody></table></div>
    <h2 style="margin-top:12px;font-size:13px">每次请求</h2>
    <div style="max-height:40vh;overflow:auto"><table><thead><tr><th>时间</th><th>模型 → 实际服务</th><th>状态</th><th>输入 tokens</th><th>其中缓存</th><th>输出 tokens</th><th>请求大小</th><th>用时</th><th>花费</th><th>交易</th></tr></thead><tbody id="cCalls"></tbody></table></div>
  </section>
</main>
<script>
const NONCE="__NONCE__", FEATURED=__FEATURED__;
const $=(id)=>document.getElementById(id);
const api=async(p,body)=>{const r=await fetch(p,body?{method:"POST",headers:{"x-nonce":NONCE,"content-type":"application/json"},body:JSON.stringify(body)}:{headers:{"x-nonce":NONCE}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j};
const fmt=(m)=>m==null?"—":(m/1e6).toFixed(m<10000?6:4);
let MODELS=[], STATE={}, sel=null, filter="all";
const FILTERS=[["all","全部"],["featured","常用"],["free","免费"],["cheap","便宜（输出≤$1/1M）"],["reasoning","推理"],["anthropic","Claude"],["openai","GPT"],["google","Gemini"],["deepseek","DeepSeek"],["xai","Grok"],["qwen","Qwen"],["moonshot","Kimi"]];
$("filters").innerHTML=FILTERS.map(([k,l])=>'<button class="ghost" data-f="'+k+'">'+l+'</button>').join("");
$("filters").onclick=(e)=>{const f=e.target.dataset.f;if(!f)return;filter=f;render()};
$("q").oninput=render;
function shown(){const q=$("q").value.trim().toLowerCase();return MODELS.filter(m=>{
  if(q&&!(m.id+" "+m.name+" "+m.owner).toLowerCase().includes(q))return false;
  if(filter==="featured")return FEATURED.includes(m.id);if(filter==="free")return m.free;if(filter==="cheap")return m.free||m.output<=1;
  if(filter==="reasoning")return m.reasoning;if(filter!=="all")return m.id.startsWith(filter+"/");return true}).sort((a,b)=>{
  const fa=FEATURED.indexOf(a.id),fb=FEATURED.indexOf(b.id);if(fa>=0||fb>=0)return (fa<0?99:fa)-(fb<0?99:fb);return a.id.localeCompare(b.id)})}
function render(){
  document.querySelectorAll("#filters button").forEach(b=>b.classList.toggle("on",b.dataset.f===filter));
  const list=shown();$("list").innerHTML=list.map(m=>'<div class="row'+(sel&&sel.id===m.id?' sel':'')+'" data-id="'+m.id+'"><div><div class="id">'+m.id+(m.id===STATE.defaultModel?'<span class="tag t-def">默认</span>':'')+(m.free?'<span class="tag t-free">免费</span>':'')+(m.reasoning?'<span class="tag t-r">推理</span>':'')+'</div><div class="muted">'+(m.name||"")+(m.context?' · 上下文 '+Math.round(m.context/1000)+'K':'')+'</div></div><div class="p">'+(m.free?"免费":"入 $"+m.input+" / 出 $"+m.output+"<br>每 1M tokens")+'</div></div>').join("")||'<div class="muted">没有匹配的模型</div>';
}
$("list").onclick=(e)=>{const row=e.target.closest(".row");if(!row)return;sel=MODELS.find(m=>m.id===row.dataset.id);showSel();render()};
function showSel(){if(!sel)return;$("selName").textContent="· "+sel.id;est()}
function est(){if(!sel)return;const mt=+$("mt").value;$("est").textContent=sel.free?"免费":"本次最多约 $"+((sel.output*mt+sel.input*800)/1e6).toFixed(4)+"（按最长回复预付）"}
$("mt").onchange=est;
$("setDef").onclick=async()=>{if(!sel)return alert("先在左边选一个模型");await api("/api/config",{defaultModel:sel.id});await refresh();render()};
$("saveCaps").onclick=async()=>{await api("/api/config",{maxPerCall:+$("cap1").value,dailyCap:+$("cap2").value});await refresh();alert("已保存，Cursor 下次调用就生效")};
$("probe").onclick=()=>{$("prompt").value="请直接回答：1. 你是哪家公司开发的什么模型，具体版本号？2. 你的训练数据截止到哪年哪月？3. 用一句话说出你和同系列上一代模型最大的区别。"};
$("ask").onclick=async()=>{
  const prompt=$("prompt").value.trim();if(!prompt)return;const model=sel?sel.id:STATE.defaultModel;
  $("ask").disabled=true;$("out").innerHTML='<div class="muted">'+model+' 思考中…（付费模型会先报价、本机签名付款）</div>';
  try{const r=await api("/api/chat",{model,prompt,max_tokens:+$("mt").value});
    const mism=r.served&&r.served.toLowerCase()!==r.requested.toLowerCase();
    $("out").innerHTML='<div class="ans"></div><div class="foot'+(mism?' warn':'')+'"></div>';
    $("out").querySelector(".ans").textContent=r.text||"（空回答）";
    $("out").querySelector(".foot").innerHTML=(mism?"⚠ 选的是 "+r.requested+"，BlockRun 说实际是 ":"实际服务：")+r.served+(r.usage?" · tokens 入 "+(r.usage.prompt_tokens??"?")+" / 出 "+(r.usage.completion_tokens??"?"):"")+" · 花费 "+r.costText+(r.tx?' · <a target="_blank" href="https://basescan.org/tx/'+r.tx+'">查看交易</a>':"");
  }catch(e){$("out").innerHTML='<div class="err">'+e.message+'</div>'}
  $("ask").disabled=false;refresh()};
async function refresh(){
  STATE=await api("/api/state");
  $("addr").textContent=STATE.address?STATE.address.slice(0,6)+"…"+STATE.address.slice(-4):"没有钱包";
  $("bal").textContent=fmt(STATE.balance);$("spent").textContent="$"+fmt(STATE.spent)+" · "+STATE.calls+" 笔";$("def").textContent=STATE.defaultModel;
  if(document.activeElement!==$("cap1"))$("cap1").value=STATE.maxPerCall;if(document.activeElement!==$("cap2"))$("cap2").value=STATE.dailyCap;
  $("hist").innerHTML=STATE.history.map(h=>{const mism=h.served&&h.served.toLowerCase()!==h.requested.toLowerCase();return '<tr><td>'+new Date(h.at).toLocaleString()+'</td><td>'+(h.via==="ui"?"界面":"Cursor")+'</td><td>'+h.requested+(mism?' → <span class="warn">'+h.served+'</span>':'')+'<div class="muted">'+(h.prompt||"").replace(/</g,"&lt;")+'</div></td><td>'+(h.inTok??"")+" / "+(h.outTok??"")+'</td><td>'+(h.cost?"$"+fmt(h.cost):"免费")+'</td><td>'+(h.tx?'<a target="_blank" href="https://basescan.org/tx/'+h.tx+'">查看</a>':"")+'</td></tr>'}).join("")||'<tr><td colspan="6" class="muted">还没有调用</td></tr>';
}
const n=(v)=>v==null?"—":Number(v).toLocaleString();
async function cursorLog(){
  try{const j=await api("/api/cursor");
    const ok=j.calls.filter(c=>c.status===200);
    $("cSum").innerHTML="今天 <b>$"+fmt(j.spentToday)+"</b>（每天上限 $"+(j.dailyCap/1e6)+"，单条 $"+(j.maxPerCall/1e6)+"）· 付款钱包 "+(j.address||"—")+" · 最近 "+j.calls.length+" 条里成功 "+ok.length+" 条";
    $("cDays").innerHTML=j.days.map(d=>'<tr><td>'+d.day+'</td><td>'+d.model+'</td><td>'+d.calls+'</td><td>'+n(d.in_tok)+'</td><td>'+n(d.out_tok)+'</td><td>$'+fmt(d.cost)+'</td><td>$'+fmt(d.cost/d.calls)+'</td></tr>').join("")||'<tr><td colspan="7" class="muted">还没有</td></tr>';
    $("cCalls").innerHTML=j.calls.map(c=>{const mism=c.served&&c.served.toLowerCase()!==c.model.toLowerCase();return '<tr><td>'+new Date(c.at).toLocaleString()+'</td><td>'+c.model+(mism?' → <span class="warn">'+c.served+'</span>':'')+'</td><td'+(c.status===200?'':' class="err"')+'>'+c.status+'</td><td>'+n(c.in_tok)+'</td><td>'+n(c.cached_tok)+'</td><td>'+n(c.out_tok)+'</td><td>'+(c.req_bytes?Math.round(c.req_bytes/1024)+" KB":"—")+'</td><td>'+(c.ms?(c.ms/1000).toFixed(1)+" 秒":"—")+'</td><td>'+(c.cost?"$"+fmt(c.cost):"—")+'</td><td>'+(c.tx?'<a target="_blank" href="https://basescan.org/tx/'+c.tx+'">查看</a>':"")+'</td></tr>'}).join("")||'<tr><td colspan="10" class="muted">还没有</td></tr>';
  }catch(e){$("cSum").innerHTML='<span class="err">取不到服务器明细：'+e.message+'</span>'}}
$("cRefresh").onclick=cursorLog;
cursorLog();setInterval(cursorLog,30000);
(async()=>{await refresh();MODELS=await api("/api/models");sel=MODELS.find(m=>m.id===STATE.defaultModel)||MODELS[0];filter="featured";showSel();render()})().catch(e=>{$("list").innerHTML='<div class="err">'+e.message+'</div>'});
</script></body></html>`;
