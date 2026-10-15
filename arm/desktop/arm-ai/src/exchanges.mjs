/**
 * Top-up helpers: fetch an exchange's official Windows installer, check its Authenticode signature, start it.
 * Only these fixed official URLs; a file whose signature is not valid or not from the expected publisher is deleted.
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const exchanges = [
  {
    id: "binance",
    name: "Binance",
    urls: [
      "https://download.binance.com/electron-desktop/windows/production/binance-setup.exe",
      "https://download.binance.info/electron-desktop/windows/production/binance-setup.exe",
    ],
    page: "https://www.binance.com/download",
    file: "binance-setup.exe",
    publisher: /(^|, )O="?Binance Holdings Limited"?(,|$)/,
  },
  {
    id: "okx",
    name: "OKX",
    urls: ["https://static.okx.com/upgradeapp/OKX_Setup_Win10_x64.exe"],
    page: "https://www.okx.com/download",
    file: "OKX_Setup_Win10_x64.exe",
    publisher: /(^|, )O="?OKX Global Holding Company Limited"?(,|$)/,
  },
];

const jobs = new Map();
const downloads = () => {
  const d = join(homedir(), "Downloads");
  mkdirSync(d, { recursive: true });
  return d;
};

/** the proxy the user's browser uses (Clash / v2rayN set the Windows system proxy), so blocked sites still load */
export function systemProxy() {
  const env = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (env) return env;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", windowsHide: true });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(out)) return null;
    const s = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
    const pick = s?.includes("=") ? (/https=([^;]+)/.exec(s)?.[1] ?? /http=([^;]+)/.exec(s)?.[1]) : s;
    return pick ? (pick.includes("://") ? pick : `http://${pick}`) : null;
  } catch {
    return null;
  }
}

/** Windows' own Authenticode check: { status: "Valid" | …, subject } */
export function signature(path) {
  const ps = "$s=Get-AuthenticodeSignature -LiteralPath $env:ARM_FILE; @{status=[string]$s.Status; subject=[string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, env: { ...process.env, ARM_FILE: path } });
  return JSON.parse(out.trim());
}

const trusted = (x, sig) => sig.status === "Valid" && x.publisher.test(sig.subject);
const org = (subject) => /O=("[^"]+"|[^,]+)/.exec(subject)?.[1]?.replace(/"/g, "") ?? subject;

/** progress of the last download per exchange (what the UI polls) */
export const downloadState = () => Object.fromEntries([...jobs].map(([id, j]) => [id, { phase: j.phase, got: j.got, total: j.total, error: j.error, signer: j.signer, file: j.file }]));

export function run(id) {
  const j = jobs.get(id);
  if (j?.phase !== "ready") return { error: "not downloaded" };
  // Start-Process goes through the shell, so installers that need admin rights get the UAC prompt
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:ARM_FILE"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ARM_FILE: j.file },
  });
  p.on("error", () => {});
  p.unref();
  return { ok: true };
}

export function openPage(id) {
  const x = exchanges.find((e) => e.id === id);
  if (!x) return { error: "unknown exchange" };
  spawn("cmd.exe", ["/c", "start", "", x.page], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { ok: true };
}

/** stream the installer to `part`: every official URL through the system proxy, then directly; j.got / j.total track progress */
export async function fetchTo(x, part, j, log = () => {}) {
  let last;
  const proxies = [systemProxy(), null].filter((p, i, a) => a.indexOf(p) === i);
  for (const [proxy, url] of proxies.flatMap((p) => x.urls.map((u) => [p, u]))) {
    try {
      j.got = 0;
      j.total = 0;
      const r = await fetch(url, { ...(proxy ? { proxy } : {}), signal: AbortSignal.timeout(30 * 60_000) });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      j.total = Number(r.headers.get("content-length")) || 0;
      await pipeline(
        Readable.fromWeb(r.body),
        async function* (src) {
          for await (const c of src) {
            j.got += c.length;
            yield c;
          }
        },
        createWriteStream(part),
      );
      if (j.total && j.got !== j.total) throw new Error(`incomplete (${j.got} of ${j.total} bytes)`);
      return;
    } catch (e) {
      last = e;
      rmSync(part, { force: true });
      log(`download ${new URL(url).host}${proxy ? ` via ${proxy}` : ""} failed / 下载失败: ${e.message}`);
    }
  }
  throw last;
}

/** download (or reuse a verified earlier download), check the signature, then start the installer */
export function download(id, log = () => {}) {
  const x = exchanges.find((e) => e.id === id);
  if (!x) return { error: "unknown exchange" };
  if (jobs.get(id)?.phase === "downloading" || jobs.get(id)?.phase === "verifying") return { ok: true };
  const file = join(downloads(), x.file);
  const j = { phase: "downloading", got: 0, total: 0, error: null, signer: null, file };
  jobs.set(id, j);
  void (async () => {
    try {
      const done = existsSync(file) ? signature(file) : null;
      if (!done || !trusted(x, done)) {
        await fetchTo(x, `${file}.part`, j, log);
        rmSync(file, { force: true });
        renameSync(`${file}.part`, file);
      }
      j.phase = "verifying";
      const sig = signature(file);
      j.signer = org(sig.subject);
      if (!trusted(x, sig)) {
        rmSync(file, { force: true });
        j.phase = "badsig";
        log(`download ${x.id}: signature ${sig.status} ${sig.subject}, deleted / 签名不对，已删除`);
        return;
      }
      j.phase = "ready";
      log(`download ${x.id}: ${file} signed by ${j.signer}, starting the installer / 已核对签名，打开安装程序`);
      run(id);
    } catch (e) {
      j.phase = "failed";
      j.error = e.message;
    }
  })();
  return { ok: true };
}
