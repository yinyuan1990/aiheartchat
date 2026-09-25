/**
 * Arm 域名管理器 — 交互式命令行，打包成 Windows exe（node ops/build-exe.mjs → ops/dist/arm-domains.exe）。
 * 通过 SSH 调服务器上的 /opt/arm/ops/domains.sh 完成：nginx 渲染 → 证书签发 / 扩展 → PUBLIC_DOMAINS → 重启索引器。
 * 配了 Cloudflare API Token 时，添加域名会自动创建 `@` / `www` 两条 A 记录（DNS only）并等待生效。
 *
 * 配置文件：exe 同目录 arm-domains.json
 *   { "host": "45.205.17.161", "user": "root", "key": "C:\\Users\\me\\.ssh\\arm_ed25519", "cfToken": "..." }
 * 未配置时依次回退：~/.ssh/arm_ed25519；host 默认 45.205.17.161。
 */
import { Client } from "ssh2";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Resolver } from "node:dns/promises";

const IS_SEA = typeof process.execPath === "string" && !process.execPath.toLowerCase().endsWith("node.exe");
const CFG_PATH = join(IS_SEA ? dirname(process.execPath) : process.cwd(), "arm-domains.json");
const cfg = { host: "45.205.17.161", user: "root", key: join(homedir(), ".ssh", "arm_ed25519"), cfToken: "", ...(existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, "utf8")) : {}) };
const saveCfg = () => writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));

// Windows consoles default to the ANSI code page (GBK here) — switch this console to UTF-8 so Chinese renders
if (process.platform === "win32") { try { execSync("chcp 65001", { stdio: "ignore" }); } catch {} }
const rl = createInterface({ input: stdin, output: stdout });
rl.on("close", () => process.exit(0)); // stdin ended (piped input / Ctrl+C) → leave quietly
const ask = async (q) => (await rl.question(q)).trim();
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i;

// ---------------------------------------------------------------- ssh
function ssh(cmd) {
  return new Promise((res, rej) => {
    if (!existsSync(cfg.key)) return rej(new Error(`找不到 SSH 私钥：${cfg.key}（在配置里改 key 路径）`));
    const conn = new Client();
    let out = "";
    conn
      .on("ready", () => conn.exec(cmd, (err, stream) => {
        if (err) return rej(err);
        stream.on("data", (d) => { out += d; stdout.write(d); });
        stream.stderr.on("data", (d) => { out += d; stdout.write(d); });
        stream.on("close", (code) => { conn.end(); code === 0 ? res(out) : rej(new Error(`远端命令退出码 ${code}`)); });
      }))
      .on("error", (e) => rej(new Error(`SSH 连接失败：${e.message}`)))
      .connect({ host: cfg.host, username: cfg.user, privateKey: readFileSync(cfg.key), readyTimeout: 30_000, keepaliveInterval: 10_000 });
  });
}
const domainsSh = (args) => ssh(`bash /opt/arm/ops/domains.sh ${args}`);

// ---------------------------------------------------------------- cloudflare (optional)
async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${cfg.cfToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const j = await res.json();
  if (!j.success) throw new Error(`Cloudflare: ${(j.errors ?? []).map((e) => e.message).join("; ") || res.status}`);
  return j.result;
}
async function cfEnsureA(domain, ip) {
  const zones = await cf(`/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.length) throw new Error(`Cloudflare 账号里没有 ${domain} 这个 zone（域名要先在 Cloudflare 注册 / 接管 DNS）`);
  const zone = zones[0].id;
  for (const name of [domain, `www.${domain}`]) {
    const existing = await cf(`/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(name)}`);
    if (existing.length) {
      const r = existing[0];
      if (r.content === ip && r.proxied === false) { console.log(`  DNS 已存在：${name} → ${ip}（DNS only）`); continue; }
      await cf(`/zones/${zone}/dns_records/${r.id}`, { method: "PUT", body: JSON.stringify({ type: "A", name, content: ip, ttl: 300, proxied: false }) });
      console.log(`  DNS 已更新：${name} → ${ip}（DNS only）`);
    } else {
      await cf(`/zones/${zone}/dns_records`, { method: "POST", body: JSON.stringify({ type: "A", name, content: ip, ttl: 300, proxied: false }) });
      console.log(`  DNS 已创建：${name} → ${ip}（DNS only）`);
    }
  }
}
async function waitDns(domain, ip, timeoutMs = 180_000) {
  const r = new Resolver();
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  const t0 = Date.now();
  for (;;) {
    const [a, w] = await Promise.all([r.resolve4(domain).catch(() => []), r.resolve4(`www.${domain}`).catch(() => [])]);
    if (a.includes(ip) && w.includes(ip)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    stdout.write(".");
    await new Promise((s) => setTimeout(s, 5000));
  }
}

// ---------------------------------------------------------------- actions
async function list() {
  console.log("\n— 当前域名 —");
  await domainsSh("list");
}

async function add() {
  const d = (await ask("要添加的域名（例如 example.com）：")).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!DOMAIN_RE.test(d)) return console.log("域名格式不对。");
  if (cfg.cfToken) {
    console.log("正在 Cloudflare 创建 DNS 记录…");
    try {
      await cfEnsureA(d, cfg.host);
      stdout.write("等待 DNS 生效");
      const ok = await waitDns(d, cfg.host);
      console.log(ok ? " 已生效" : " 超时（继续执行，服务器会跳过证书，稍后再「重新应用」即可）");
    } catch (e) {
      console.log(`\nCloudflare 步骤失败：${e.message}\n请手动在 Cloudflare 加 @ 和 www 两条 A 记录 → ${cfg.host}（灰云），然后继续。`);
      if ((await ask("继续在服务器上添加？(y/N) ")).toLowerCase() !== "y") return;
    }
  } else {
    console.log(`未配置 Cloudflare Token：请先在 Cloudflare 手动加 @ 和 www 两条 A 记录 → ${cfg.host}（灰云 / DNS only）。`);
    if ((await ask("DNS 已加好，继续？(y/N) ")).toLowerCase() !== "y") return;
  }
  console.log("正在服务器上应用（nginx → 证书 → 索引器）…");
  await domainsSh(`add ${d}`);
}

async function remove() {
  const d = (await ask("要移除的域名：")).toLowerCase();
  if (!DOMAIN_RE.test(d)) return console.log("域名格式不对。");
  if ((await ask(`确认从站点移除 ${d}？该域名将不再解析到本站。(y/N) `)).toLowerCase() !== "y") return;
  await domainsSh(`remove ${d}`);
}

async function setPrimary() {
  const cur = await ssh("grep -E '^PUBLIC_DOMAINS=' /opt/arm/.env | cut -d= -f2-");
  const list = cur.trim().split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length < 2) return console.log("只有一个域名，无需设置。");
  list.forEach((d, i) => console.log(`  ${i + 1}. ${d}${i === 0 ? "（当前主域名）" : ""}`));
  const n = Number(await ask("选择新的主域名编号："));
  if (!Number.isInteger(n) || n < 1 || n > list.length) return console.log("无效编号。");
  const next = [list[n - 1], ...list.filter((_, i) => i !== n - 1)];
  await domainsSh(`set "${next.join(" ")}"`);
}

async function reapply() {
  console.log("按当前列表重新渲染 nginx、补签证书、重启索引器…");
  const cur = await ssh("grep -E '^PUBLIC_DOMAINS=' /opt/arm/.env | cut -d= -f2-");
  await domainsSh(`set "${cur.trim().split(",").join(" ")}"`);
}

async function configure() {
  console.log(`\n配置文件：${CFG_PATH}`);
  const host = await ask(`服务器 IP [${cfg.host}]：`); if (host) cfg.host = host;
  const key = await ask(`SSH 私钥路径 [${cfg.key}]：`); if (key) cfg.key = key;
  const tok = await ask(`Cloudflare API Token（留空保持不变；输入 - 清除）[${cfg.cfToken ? "已配置" : "未配置"}]：`);
  if (tok === "-") cfg.cfToken = ""; else if (tok) cfg.cfToken = tok;
  saveCfg();
  console.log("已保存。Cloudflare Token 需要权限：Zone → DNS → Edit（对要管理的域名或全部 zone）。");
}

// ---------------------------------------------------------------- menu
async function main() {
  console.log("Arm 域名管理器  (服务器 " + cfg.host + (cfg.cfToken ? "，Cloudflare 自动 DNS 已开" : "，Cloudflare 自动 DNS 未配置") + ")");
  for (;;) {
    console.log("\n 1. 查看域名状态\n 2. 添加域名\n 3. 移除域名\n 4. 设置主域名\n 5. 重新应用（补证书 / 修 nginx）\n 6. 配置（服务器 / 密钥 / Cloudflare Token）\n 0. 退出");
    const c = await ask("选择：");
    try {
      if (c === "1") await list();
      else if (c === "2") await add();
      else if (c === "3") await remove();
      else if (c === "4") await setPrimary();
      else if (c === "5") await reapply();
      else if (c === "6") await configure();
      else if (c === "0") break;
    } catch (e) {
      console.log(`\n出错：${e.message}`);
    }
  }
  rl.close();
}
main().catch(async (e) => {
  console.error(`\n程序出错：${e.message}`);
  // keep the window open when launched by double-click so the message can be read
  try { await ask("按回车退出…"); } catch {}
  process.exit(1);
});
