/**
 * The local UI (served only on 127.0.0.1, every API call carries the per-run nonce). Sci-fi HUD: near-black teal
 * ground, one cold line colour (one warm colour once the link is not healthy), 1–2 px frames with ticks / corner marks /
 * numbers, drawn outer-first; numbers scramble before they settle, status text types out, a lock-on box lands on what
 * changed. Lines glow a little, text never does. Everything animated is skipped under prefers-reduced-motion.
 */
export const page = ({ nonce, locales }) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arm AI</title>
<style>
:root{--bg:#030c0e;--cold:#4fe3f0;--warm:#ffad42;--c:var(--cold);--glow:drop-shadow(0 0 2px var(--c)) drop-shadow(0 0 6px color-mix(in srgb,var(--c) 45%,transparent))}
body[data-mode=warm]{--c:var(--warm)}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:color-mix(in srgb,var(--c) 88%,#fff 12%);font:13.5px/1.6 "Cascadia Mono","JetBrains Mono",Consolas,"Microsoft YaHei",ui-monospace,monospace;transition:color .5s}
body{background:radial-gradient(1200px 700px at 50% -10%,color-mix(in srgb,var(--c) 7%,transparent),transparent 70%),var(--bg);min-height:100vh}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:50;background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px)}
body::before{content:"";position:fixed;left:0;right:0;height:120px;top:-120px;pointer-events:none;z-index:49;background:linear-gradient(transparent,color-mix(in srgb,var(--c) 6%,transparent),transparent);animation:sweep 7s linear infinite}
@keyframes sweep{to{top:100%}}
.dim{color:color-mix(in srgb,var(--c) 55%,var(--bg))}.faint{color:color-mix(in srgb,var(--c) 38%,var(--bg))}
.hot{color:var(--warm)}b{color:var(--c);font-weight:600}
a{color:var(--c)}
/* frames: drawn in SVG over each panel */
.hud{position:relative;padding:22px 22px 18px}
.hud>svg.f{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;filter:var(--glow)}
.hud>svg.f path,.hud>svg.f line,.hud>svg.f rect{fill:none;stroke:var(--c);vector-effect:non-scaling-stroke;transition:stroke .5s}
.drawn path,.drawn line{stroke-dasharray:1;stroke-dashoffset:1;animation:draw var(--t,.7s) cubic-bezier(.6,.1,.3,1) forwards;animation-delay:var(--d,0s)}
@keyframes draw{to{stroke-dashoffset:0}}
.hud .no{position:absolute;top:-9px;left:26px;padding:0 6px;background:var(--bg);font-size:11px;letter-spacing:.2em}
.hud h2{margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--c)}
.hud h2 .tag{float:right;font-weight:400;letter-spacing:.1em}
header.hud{display:flex;align-items:center;gap:16px;margin:18px 24px 6px;padding:14px 22px}
header h1{margin:0;font-size:18px;letter-spacing:.35em;color:var(--c)}header .sp{flex:1}
#status{min-width:200px;text-align:right;letter-spacing:.06em}
.cur{display:inline-block;width:.6em;height:1.05em;margin-left:2px;vertical-align:-2px;background:var(--c);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
main{max-width:1120px;margin:0 auto;padding:16px 24px;display:grid;grid-template-columns:1.25fr 1fr;gap:26px 22px}
.wide{grid-column:1/-1}
/* controls: hairline, chamfered, no fill */
button,select,input{font:inherit;color:var(--c);background:transparent;border:1px solid color-mix(in srgb,var(--c) 70%,transparent);padding:5px 12px;clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);letter-spacing:.06em;transition:color .5s,border-color .5s,background .15s}
button{cursor:pointer;text-transform:uppercase;font-size:12px}button:hover,select:hover{background:color-mix(in srgb,var(--c) 14%,transparent)}
button:active{background:color-mix(in srgb,var(--c) 28%,transparent)}
button.pri{border-width:2px;padding:6px 16px}
select option{background:var(--bg);color:var(--c)}
input{width:96px;text-align:right}input:focus,select:focus,button:focus-visible{outline:1px solid var(--c);outline-offset:2px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}
.lbl{font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.field{display:flex;gap:8px;align-items:stretch;margin:6px 0}
.val{flex:1;border:1px solid color-mix(in srgb,var(--c) 35%,transparent);padding:5px 10px;word-break:break-all;min-height:32px}
.big{font-size:34px;font-weight:600;letter-spacing:.04em;color:var(--c);font-variant-numeric:tabular-nums}
.qr{float:right;width:150px;height:150px;margin:0 0 10px 16px;padding:7px;background:var(--c);transition:background .5s}
.qr svg{display:block;width:100%;height:100%}.qr svg path:first-child{fill:var(--c)}.qr svg path:last-child{stroke:var(--bg)}
ol{margin:6px 0 10px;padding-left:22px}li{margin:3px 0}li::marker{color:color-mix(in srgb,var(--c) 55%,var(--bg))}
.chip{display:inline-block;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);padding:0 7px;margin:2px 4px 2px 0;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
th{font-weight:400;text-align:left;letter-spacing:.14em;text-transform:uppercase;font-size:10.5px;color:color-mix(in srgb,var(--c) 55%,var(--bg));border-bottom:1px solid color-mix(in srgb,var(--c) 45%,transparent);padding:5px 6px}
td{padding:5px 6px;border-bottom:1px dashed color-mix(in srgb,var(--c) 18%,transparent);vertical-align:top}
tr.mis td{color:var(--warm)}
.list{max-height:330px;overflow:auto;scrollbar-color:color-mix(in srgb,var(--c) 40%,transparent) transparent}
#q{width:100%;text-align:left}
footer{max-width:1120px;margin:0 auto 34px;padding:0 24px;font-size:11.5px}
/* lock-on box */
.lock{position:fixed;z-index:40;pointer-events:none;transition:left .42s cubic-bezier(.2,.8,.2,1),top .42s cubic-bezier(.2,.8,.2,1),width .42s cubic-bezier(.2,.8,.2,1),height .42s cubic-bezier(.2,.8,.2,1);filter:var(--glow)}
.lock i{position:absolute;width:14px;height:14px;border:2px solid var(--c)}
.lock i:nth-child(1){left:0;top:0;border-right:0;border-bottom:0}.lock i:nth-child(2){right:0;top:0;border-left:0;border-bottom:0}
.lock i:nth-child(3){left:0;bottom:0;border-right:0;border-top:0}.lock i:nth-child(4){right:0;bottom:0;border-left:0;border-top:0}
.lock em{position:absolute;left:0;top:-17px;font-style:normal;font-size:10px;letter-spacing:.2em;background:var(--bg);padding:0 4px}
.lock.land{animation:land .36s steps(1) 2}
@keyframes land{0%{opacity:1}50%{opacity:0}}
@media (max-width:900px){main{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.drawn path,.drawn line{animation:none;stroke-dashoffset:0}body::before{display:none}.cur{animation:none}.lock{display:none}}
</style></head><body data-mode="cold">
<header class="hud" id="top"><span class="no">ARM-AI · v<span id="ver"></span></span><h1>ARM AI</h1><span class="dim" data-t="app.tagline"></span><span class="sp"></span>
<span id="status"></span><select id="lang"></select></header>
<main>
<section class="hud" data-n="01"><h2 data-t="wallet.title"></h2>
  <div class="qr" id="qr"></div>
  <div class="lbl dim" data-t="wallet.address"></div>
  <div class="field"><span class="val" id="addr">…</span><button data-copy="addr" data-t="common.copy"></button></div>
  <div class="lbl dim" style="margin-top:12px" data-t="wallet.balance"></div><div class="big" id="usdc">––––</div>
  <p data-t="wallet.topup" data-md></p>
  <p class="dim" data-t="wallet.backup"></p>
  <div class="row"><button id="export" data-t="wallet.export"></button><span class="val" id="pk" style="display:none"></span></div>
</section>
<section class="hud" data-n="02"><h2 data-t="caps.title"></h2>
  <div class="row"><span class="lbl dim" style="width:150px" data-t="caps.perCall"></span><input id="perCall" type="number" min="0.01" step="0.01"></div>
  <div class="row"><span class="lbl dim" style="width:150px" data-t="caps.daily"></span><input id="daily" type="number" min="0.1" step="0.1"><button id="saveCaps" data-t="common.save"></button><span id="capsMsg"></span></div>
  <p class="big" style="font-size:22px;margin:14px 0 4px" id="todayNum">$0.0000</p><p class="dim" id="today" style="margin:0"></p>
  <p class="faint" data-t="caps.why"></p>
</section>
<section class="hud wide" data-n="03"><h2 data-t="cursor.title"></h2>
  <div class="row"><span class="lbl dim" data-t="cursor.found"></span><span id="installs"></span><button id="rescan" data-t="cursor.rescan"></button></div>
  <p data-t="cursor.steps" style="margin:10px 0 0"></p>
  <ol><li data-t="cursor.step1"></li><li data-t="cursor.step2"></li><li id="step3"></li><li data-t="cursor.step4"></li></ol>
  <div class="field"><span class="lbl dim" style="width:90px;align-self:center" data-t="cursor.baseUrl"></span><span class="val" id="base"></span><button data-copy="base" data-t="common.copy"></button></div>
  <div class="field"><span class="lbl dim" style="width:90px;align-self:center" data-t="cursor.key"></span><span class="val" id="key"></span><button id="showKey" data-t="common.show"></button><button data-copy="key" data-t="common.copy"></button></div>
  <p class="hot" data-t="cursor.note"></p>
  <div class="row"><button class="pri" id="test" data-t="cursor.test"></button><span id="testMsg"></span></div>
</section>
<section class="hud wide" data-n="04"><h2 data-t="mcp.title"></h2><p class="dim" data-t="mcp.desc"></p>
  <div class="row"><button id="mcp"></button><span id="mcpMsg"></span></div></section>
<section class="hud wide" data-n="05"><h2><span data-t="log.title"></span><span class="tag"><button id="tabServer" data-t="log.server"></button> <button id="tabLocal" data-t="log.local"></button></span></h2>
  <div class="list" id="log"></div></section>
<section class="hud wide" data-n="06"><h2 data-t="models.title"></h2>
  <input id="q" data-tp="models.search"><div class="list" id="models" style="margin-top:10px"></div></section>
</main>
<footer class="faint" data-t="footer.fee"></footer>
<script>
const NONCE=${JSON.stringify(nonce)}, L=${JSON.stringify(locales)};
const CALM=matchMedia("(prefers-reduced-motion: reduce)").matches;
const pick=()=>{const s=localStorage.getItem("armai-lang");if(s&&L[s])return s;const n=(navigator.language||"").toLowerCase();return n.startsWith("zh")&&L.zh?"zh":(L[n.split("-")[0]]?n.split("-")[0]:"en")};
let lang=pick();
const t=(k,p={})=>String((L[lang]&&L[lang][k])??L.zh[k]??k).replace(/\\{(\\w+)\\}/g,(_,n)=>p[n]??"");
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const md=s=>esc(s).replace(/\\*\\*(.+?)\\*\\*/g,"<b>$1</b>");
const $=id=>document.getElementById(id);
const api=(p,b)=>fetch(p,{method:b?"POST":"GET",headers:{"x-arm-nonce":NONCE,"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const usd=m=>"$"+(m/1e6).toFixed(m&&m<1e4?6:4);
const NS="http://www.w3.org/2000/svg";

/* ---------- frames: outer contour first, then corner marks / ticks / divider, panel by panel */
function frame(el,i,animate){
  const w=el.offsetWidth,h=el.offsetHeight,c=12,size=w+"x"+h;
  if(!animate&&el.dataset.size===size)return;
  el.dataset.size=size;
  el.querySelector(":scope>svg.f")?.remove();
  const svg=document.createElementNS(NS,"svg");
  svg.setAttribute("class","f"+(animate&&!CALM?" drawn":""));svg.setAttribute("viewBox","0 0 "+w+" "+h);
  const add=(d,delay,dur,width=1)=>{const p=document.createElementNS(NS,"path");p.setAttribute("d",d);p.setAttribute("pathLength","1");p.setAttribute("stroke-width",width);p.style.setProperty("--d",delay+"s");p.style.setProperty("--t",dur+"s");svg.appendChild(p);};
  const o=i*0.12, inner=0.55+i*0.12;
  // outer contour, chamfered top-left and bottom-right
  add("M"+(c+.5)+",.5 H"+(w-.5)+" V"+(h-c-.5)+" L"+(w-c-.5)+","+(h-.5)+" H.5 V"+(c+.5)+" Z",o,0.8);
  // corner marks (2 px) just inside
  const k=16,m=5;
  add("M"+m+","+(m+k)+" V"+m+" H"+(m+k),inner,0.25,2);
  add("M"+(w-m-k)+","+m+" H"+(w-m)+" V"+(m+k),inner+0.05,0.25,2);
  add("M"+m+","+(h-m-k)+" V"+(h-m)+" H"+(m+k),inner+0.1,0.25,2);
  add("M"+(w-m-k)+","+(h-m)+" H"+(w-m)+" V"+(h-m-k),inner+0.15,0.25,2);
  // ticks along the top edge (every 8 px, every 4th longer) and down the right edge
  let d="";for(let x=w-150,n=0;x<w-24;x+=8,n++)d+="M"+x+",1 V"+(n%4?5:9)+" ";add(d,inner+0.2,0.5);
  d="";for(let y=28,n=0;y<Math.min(h-24,150);y+=8,n++)d+="M"+(w-1)+","+y+" H"+(w-(n%4?5:9))+" ";add(d,inner+0.25,0.5);
  // divider under the heading
  const hd=el.querySelector(":scope>h2");if(hd){const y=hd.offsetTop+hd.offsetHeight+4;add("M22,"+y+" H"+Math.min(w*0.42,320),inner+0.3,0.4);}
  el.prepend(svg);
  if(el.dataset.n&&!el.querySelector(":scope>.no")){const s=document.createElement("span");s.className="no";s.textContent=el.dataset.n+" //";el.prepend(s);}
}
const panels=()=>[...document.querySelectorAll(".hud")];
function frames(animate){panels().forEach((el,i)=>frame(el,i,animate));}
// after the first draw, only panels whose size changed are redrawn, instantly
let rt,drawnOnce=false;new ResizeObserver(()=>{if(!drawnOnce)return;clearTimeout(rt);rt=setTimeout(()=>frames(false),120)}).observe(document.body);

/* ---------- numbers scramble a few frames, then settle */
const scrambling=new WeakMap();
function scramble(el,text){
  if(el.dataset.v===text)return;el.dataset.v=text;
  if(CALM){el.textContent=text;return;}
  clearInterval(scrambling.get(el));let f=0;
  const id=setInterval(()=>{f++;if(f>9){clearInterval(id);el.textContent=text;return;}
    el.textContent=text.replace(/\\d/g,()=>String(Math.floor(Math.random()*10)));},45);
  scrambling.set(el,id);
}
/* ---------- status text types out, with a cursor */
const typing=new WeakMap();
function type(el,text){
  if(el.dataset.v===text)return;el.dataset.v=text;clearInterval(typing.get(el));
  if(CALM){el.innerHTML=esc(text)+'<span class="cur"></span>';return;}
  let n=0;const id=setInterval(()=>{n++;el.innerHTML=esc(text.slice(0,n))+'<span class="cur"></span>';if(n>=text.length)clearInterval(id);},38);
  typing.set(el,id);
}
/* ---------- lock-on: a big box shrinks onto the target, blinks twice when it lands */
function lock(target,label){
  if(CALM||!target)return;
  const r=target.getBoundingClientRect();if(!r.width)return;
  const b=document.createElement("div");b.className="lock";b.innerHTML="<i></i><i></i><i></i><i></i><em>"+esc(label||"LOCK")+"</em>";
  const pad=6,grow=Math.max(innerWidth,innerHeight)*0.35;
  Object.assign(b.style,{left:(r.left-grow)+"px",top:(r.top-grow)+"px",width:(r.width+2*grow)+"px",height:(r.height+2*grow)+"px"});
  document.body.appendChild(b);b.getBoundingClientRect();
  Object.assign(b.style,{left:(r.left-pad)+"px",top:(r.top-pad)+"px",width:(r.width+2*pad)+"px",height:(r.height+2*pad)+"px"});
  setTimeout(()=>b.classList.add("land"),430);setTimeout(()=>b.remove(),1700);
}

let S=null,showKey=false,tab="server",lastStatus=null,first=true;
function paint(){document.documentElement.lang=lang==="zh"?"zh-CN":lang;
  document.querySelectorAll("[data-t]").forEach(e=>{e.innerHTML=e.hasAttribute("data-md")?md(t(e.dataset.t)):esc(t(e.dataset.t))});
  document.querySelectorAll("[data-tp]").forEach(e=>e.placeholder=t(e.dataset.tp));
  $("lang").innerHTML=Object.keys(L).map(k=>'<option value="'+k+'"'+(k===lang?" selected":"")+">"+esc(L[k]["lang.name"])+"</option>").join("");
  $("status").dataset.v="";if(S)render();}
const KEYS={online:"status.online",offline:"status.offline",unregistered:"status.unregistered",registering:"status.registering"};
function render(){const s=S;
  // healthy link = cold; anything else turns the whole HUD warm
  const mode=s.status==="online"?"cold":"warm";
  if(document.body.dataset.mode!==mode)document.body.dataset.mode=mode;
  type($("status"),"[ "+t(KEYS[s.status]||"status.offline")+" ]");
  if(lastStatus!==null&&lastStatus!==s.status)lock($("status"),s.status.toUpperCase());
  lastStatus=s.status;
  $("ver").textContent=s.version;
  $("addr").textContent=s.address;
  scramble($("usdc"),s.usdc==null?"––––":"$"+(s.usdc/1e6).toFixed(4));
  $("base").textContent=s.baseUrl;$("key").textContent=showKey?s.key:s.key.slice(0,10)+"················"+s.key.slice(-4);$("showKey").textContent=t(showKey?"common.hide":"common.show");
  $("step3").innerHTML=esc(t("cursor.step3",{examples:"§"})).replace("§",s.examples.map(x=>'<span class="chip">'+esc(x)+"</span>").join(""));
  if(document.activeElement!==$("perCall"))$("perCall").value=s.caps.maxPerCall;if(document.activeElement!==$("daily"))$("daily").value=s.caps.dailyCap;
  scramble($("todayNum"),usd(s.today.signed));$("today").textContent=t("caps.today",{amount:usd(s.today.signed),n:s.today.calls});
  const ed=s.editors[0];
  $("installs").innerHTML=ed.installs.length?ed.installs.map((i,n)=>'<span class="chip">'+String(n+1).padStart(2,"0")+" · "+esc(i.exe)+(i.version?" · v"+esc(i.version):"")+(i.running?" · ▲ "+esc(t("cursor.running")):"")+"</span>").join(""):'<span class="hot">'+esc(t("cursor.none"))+"</span>";
  $("mcp").textContent=t(ed.mcp.installed&&!ed.mcp.current?"mcp.update":"mcp.install");
  if(!$("mcpMsg").dataset.keep)$("mcpMsg").innerHTML=ed.mcp.current?esc(t("mcp.installed",{file:ed.mcp.file})):ed.mcp.installed?'<span class="hot">'+esc(t("mcp.outdated"))+"</span>":"";
  if(first){first=false;setTimeout(()=>lock($("addr"),"TARGET"),1300);}}
async function load(){S=await api("/api/state");render();}
async function loadQr(){$("qr").innerHTML=await fetch("/api/qr",{headers:{"x-arm-nonce":NONCE}}).then(r=>r.text());}
const norm=m=>String(m||"").toLowerCase().replace(/^[^/]+\\//,"").replace(/[^a-z0-9]/g,"");
const sameModel=(a,b)=>{const x=norm(a),y=norm(b);return x===y||y.startsWith(x)||x.startsWith(y)};
async function loadLog(){const j=await api("/api/log");let rows;
  if(tab==="server"){rows=(j.server||[]).map((c,n)=>{const proxy=/^ai-proxy/.test(c.served||"");const mis=!proxy&&c.served&&!sameModel(c.model,c.served);
      return '<tr class="'+(mis?"mis":"")+'" title="'+(mis?esc(t("log.mismatch")):"")+'"><td class="faint">'+String(n+1).padStart(3,"0")+"</td><td>"+esc(new Date(c.at).toLocaleString())+"</td><td>"+esc(c.model)+"</td><td"+(proxy?' class="dim"':"")+">"+(proxy?esc(t("log.proxy")):esc(c.served||""))+(mis?" ⚠":"")+"</td><td>"+(c.in_tok??"–")+" / "+(c.out_tok??"–")+"</td><td>"+usd(c.cost)+"</td><td>"+(c.ms?(c.ms/1000).toFixed(1)+"s":"")+"</td></tr>"});
    rows.unshift("<tr><th>#</th><th>"+[t("log.time"),t("log.model"),t("log.served"),t("log.tokens"),t("log.cost"),t("log.seconds")].map(esc).join("</th><th>")+"</th></tr>");}
  else{rows=(j.local||[]).map((e,n)=>'<tr><td class="faint">'+String(n+1).padStart(3,"0")+"</td><td>"+esc(new Date(e.at).toLocaleString())+"</td><td>"+esc(e.model)+"</td><td>"+(e.refused?'<span class="hot">'+esc(t("log.refused",{reason:e.refused}))+"</span>":usd(e.amount))+"</td></tr>");
    rows.unshift("<tr><th>#</th><th>"+[t("log.time"),t("log.model"),t("log.cost")].map(esc).join("</th><th>")+"</th></tr>");}
  $("log").innerHTML=rows.length>1?"<table>"+rows.join("")+"</table>":'<p class="dim">'+esc(t("log.empty"))+"</p>";
  $("tabServer").style.background=tab==="server"?"color-mix(in srgb,var(--c) 18%,transparent)":"";$("tabLocal").style.background=tab==="local"?"color-mix(in srgb,var(--c) 18%,transparent)":"";}
let models=[];
async function loadModels(){models=await api("/api/models");drawModels();}
function drawModels(){const q=$("q").value.trim().toLowerCase();
  const list=models.filter(m=>!q||(q==="free"||q==="免费"?m.free:(m.id+" "+(m.name||"")+" "+(m.owner||"")).toLowerCase().includes(q)));
  $("models").innerHTML="<table>"+list.map((m,n)=>'<tr><td class="faint">'+String(n+1).padStart(3,"0")+"</td><td>"+esc(m.id)+'</td><td class="dim">'+esc(m.name||"")+"</td><td>"+(m.free?esc(t("models.free")):esc(t("models.price",{in:m.input,out:m.output})))+'</td><td class="faint">'+(m.context?esc(t("models.ctx",{n:m.context})):"")+'</td><td><button data-copytext="'+esc(m.id)+'">'+esc(t("common.copy"))+"</button></td></tr>").join("")+"</table>";}
document.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;
  const src=b.dataset.copy?$(b.dataset.copy):null;
  const txt=b.dataset.copy?(b.dataset.copy==="key"?S.key:src.textContent):b.dataset.copytext;
  if(txt!=null){await navigator.clipboard.writeText(txt);lock(src||b.closest("tr")||b,"COPY");const o=b.textContent;b.textContent=t("common.copied");setTimeout(()=>b.textContent=o,1200);}});
$("lang").onchange=e=>{lang=e.target.value;localStorage.setItem("armai-lang",lang);api("/api/lang",{lang});paint();loadLog();drawModels();setTimeout(()=>frames(false),50);};
$("showKey").onclick=()=>{showKey=!showKey;render();};
$("saveCaps").onclick=async()=>{await api("/api/caps",{maxPerCall:Number($("perCall").value),dailyCap:Number($("daily").value)});$("capsMsg").textContent=t("common.saved");lock($("perCall").closest("section"),"CAPS");setTimeout(()=>$("capsMsg").textContent="",1500);load();};
$("rescan").onclick=()=>api("/api/rescan",{}).then(load).then(()=>lock($("installs"),"SCAN"));
$("export").onclick=async()=>{const pk=$("pk");if(pk.style.display!=="none"){pk.style.display="none";pk.textContent="";return;}if(!confirm(t("wallet.exportWarn")))return;pk.textContent=(await api("/api/export",{confirm:true})).privateKey;pk.style.display="";};
$("test").onclick=async()=>{const m=$("testMsg");m.className="dim";m.dataset.v="";type(m,t("cursor.testing"));const r=await api("/api/test",{});m.className=r.ok?"":"hot";m.dataset.v="";type(m,r.ok?t("cursor.testOk",{answer:r.answer}):t("cursor.testFail",{error:r.error}));lock(m,r.ok?"LINK OK":"LINK FAIL");};
$("mcp").onclick=async()=>{const r=await api("/api/mcp",{editor:"cursor"});$("mcpMsg").dataset.keep="1";$("mcpMsg").innerHTML=r.error?'<span class="hot">'+esc(r.error)+"</span>":esc(t("mcp.installed",{file:r.file}))+(r.backup?'<br><span class="dim">'+esc(t("mcp.backup",{file:r.backup}))+"</span>":"");lock($("mcpMsg"),"MCP");load();};
$("tabServer").onclick=()=>{tab="server";loadLog();};$("tabLocal").onclick=()=>{tab="local";loadLog();};
$("q").oninput=drawModels;
api("/api/lang",{lang});paint();
// draw the frames once the panels have their real size (outer contours first, panel by panel, then the inner marks)
Promise.allSettled([load(),loadQr(),loadLog(),loadModels()]).then(()=>requestAnimationFrame(()=>{frames(true);drawnOnce=true;}));
setInterval(load,5000);setInterval(loadLog,15000);
</script></body></html>`;
