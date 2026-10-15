/**
 * Cline (open-source coding agent, Apache-2.0) as a second way in: VS Code / Cursor / Kiro + Cline, pointed at Arm AI.
 * Cline makes its own requests, so it also works on Cursor plans that do not allow your own API key.
 * The extension comes from Open VSX (publisher saoudrizwan, verified) and is checked against Open VSX's sha256.
 * Cline 4.x keeps its settings in ~/.cline/data, shared by every editor. It reads them once when the editor starts and
 * writes its whole copy back on any change, so an editor running Cline would undo what we write: we refuse while one runs.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentHosts, appDir, product } from "./editors.mjs";
import { fetchTo, systemProxy } from "./exchanges.mjs";

const OPENVSX = "https://open-vsx.org/api/saoudrizwan/claude-dev/latest";
const EXT_DIR = /^saoudrizwan\.claude-dev-(\d+)\.(\d+)\.(\d+)$/;
const DATA = join(process.env.CLINE_DIR?.trim() || join(homedir(), ".cline"), "data");
const MODEL_RE = /^[a-z0-9][\w.\-]*\/[\w.\-:+]+$/i;
const VSCODE_PAGE = "https://code.visualstudio.com/Download";

/** newest Cline folder in an editor's extensions dir that the editor has not marked obsolete */
function installed(extDir) {
  let obsolete = {};
  try {
    obsolete = JSON.parse(readFileSync(join(extDir, ".obsolete"), "utf8"));
  } catch {}
  try {
    const v = readdirSync(extDir)
      .filter((n) => EXT_DIR.test(n) && !obsolete[n])
      .map((n) => EXT_DIR.exec(n).slice(1).map(Number))
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
    return v ? v.join(".") : null;
  } catch {
    return null;
  }
}

/** every VS Code / Cursor / Kiro install: where its CLI and extensions are, whether Cline is in it, whether it runs */
export function clineHosts() {
  return agentHosts.flatMap((h) =>
    h.detect().map((i) => {
      const app = appDir(i.exe);
      const extDir = join(homedir(), product(i.exe).dataFolderName ?? h.data, "extensions");
      return { id: h.id, name: h.name, exe: i.exe, version: i.version, running: i.running, cli: app && existsSync(join(app, "out", "cli.js")) ? join(app, "out", "cli.js") : null, extDir, cline: installed(extDir) };
    }),
  );
}

const read = (f) => {
  try {
    return JSON.parse(readFileSync(join(DATA, f), "utf8"));
  } catch {
    return {};
  }
};

/** does Cline point at us, with this PC's key (the key itself never leaves this module) */
export function clineStatus(baseUrl, key) {
  const s = read("globalState.json");
  const ours = s.openAiBaseUrl === baseUrl && s.actModeApiProvider === "openai";
  const keyOk = ours && read("secrets.json").openAiApiKey === key;
  return { ours: keyOk, otherKey: ours && !keyOk, model: ours ? (s.actModeOpenAiModelId ?? null) : null };
}

/** Cline's "OpenAI Compatible" provider → Arm AI, same model for plan and act; originals kept once as *.bak-armai */
export function clineConfigure({ baseUrl, key, model, info, hosts = clineHosts() }, log = () => {}) {
  if (typeof model !== "string" || !MODEL_RE.test(model)) return { error: "bad model" };
  const running = [...new Set(hosts.filter((h) => h.running && h.cline).map((h) => h.name))];
  if (running.length) return { running };
  mkdirSync(DATA, { recursive: true });
  for (const f of ["globalState.json", "secrets.json"]) if (existsSync(join(DATA, f)) && !existsSync(join(DATA, `${f}.bak-armai`))) copyFileSync(join(DATA, f), join(DATA, `${f}.bak-armai`));
  const mi = { maxTokens: 8192, contextWindow: info?.context ?? 128_000, supportsImages: info?.vision === true, supportsPromptCache: false, inputPrice: info?.input ?? 0, outputPrice: info?.output ?? 0 };
  const state = {
    ...read("globalState.json"),
    welcomeViewCompleted: true,
    planActSeparateModelsSetting: false,
    openAiBaseUrl: baseUrl,
    actModeApiProvider: "openai",
    planModeApiProvider: "openai",
    actModeOpenAiModelId: model,
    planModeOpenAiModelId: model,
    actModeOpenAiModelInfo: mi,
    planModeOpenAiModelInfo: mi,
  };
  writeFileSync(join(DATA, "globalState.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(DATA, "secrets.json"), JSON.stringify({ ...read("secrets.json"), openAiApiKey: key }, null, 2), { mode: 0o600 });
  log(`cline: settings → ${baseUrl}, model ${model} / Cline 设置已写入`);
  return { ok: true };
}

/** small text from Open VSX: through the system proxy first, then directly */
async function text(url) {
  let last;
  for (const proxy of [systemProxy(), null].filter((p, i, a) => a.indexOf(p) === i)) {
    try {
      const r = await fetch(url, { ...(proxy ? { proxy } : {}), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const openVsx = (u) => {
  const url = new URL(u);
  if (url.protocol !== "https:" || url.hostname !== "open-vsx.org") throw new Error(`not an Open VSX URL: ${url.host}`);
  return url.href;
};

/** the latest Cline .vsix, reused when an earlier download still matches Open VSX's sha256 */
async function vsix(j, log) {
  const meta = JSON.parse(await text(OPENVSX));
  if (meta.namespace !== "saoudrizwan" || meta.name !== "claude-dev" || meta.verified !== true) throw new Error("unexpected Open VSX entry");
  const want = (await text(openVsx(meta.files?.sha256))).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error("no sha256 from Open VSX");
  const file = join(tmpdir(), `armai-cline-${String(meta.version).replace(/[^\w.-]/g, "")}.vsix`);
  if (existsSync(file) && sha256(file) === want) return file;
  await fetchTo({ urls: [openVsx(meta.files?.download)] }, `${file}.part`, j, log);
  if (sha256(`${file}.part`) !== want) {
    rmSync(`${file}.part`, { force: true });
    throw new Error("sha256 mismatch");
  }
  rmSync(file, { force: true });
  renameSync(`${file}.part`, file);
  return file;
}

const jobs = new Map();
export const clineJobs = () => Object.fromEntries([...jobs].map(([exe, j]) => [exe, { phase: j.phase, got: j.got, total: j.total, error: j.error }]));

/** download + `<editor> --install-extension` (the editor's own CLI, as its bin\*.cmd runs it); only editors we found */
export function clineInstall(exe, log = () => {}) {
  const h = clineHosts().find((x) => x.exe === exe);
  if (!h) return { error: "unknown editor" };
  if (!h.cli) return { error: "editor CLI not found" };
  const prev = jobs.get(exe);
  if (prev?.phase === "downloading" || prev?.phase === "installing") return { ok: true };
  const j = { phase: "downloading", got: 0, total: 0, error: null };
  jobs.set(exe, j);
  void (async () => {
    try {
      const file = await vsix(j, log);
      j.phase = "installing";
      await new Promise((resolve, reject) =>
        execFile(h.exe, [h.cli, "--install-extension", file, "--force"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" }, windowsHide: true, timeout: 180_000 }, (e, out, err) => {
          if (!e) return resolve();
          const lines = `${err}\n${out}`.split(/\r?\n/).filter((l) => l.trim() && !/DeprecationWarning|trace-deprecation/.test(l));
          reject(new Error(lines.find((l) => /error|fail/i.test(l)) ?? lines.pop() ?? e.message));
        }),
      );
      if (!installed(h.extDir)) throw new Error("not in the extensions folder after install");
      j.phase = "done";
      log(`cline: installed into ${h.name} ${h.exe} / 已装进 ${h.name}`);
    } catch (e) {
      j.phase = "failed";
      j.error = e.message;
      log(`cline: install into ${h.name} failed / 安装失败: ${e.message}`);
    }
  })();
  return { ok: true };
}

export function openVscodePage() {
  spawn("cmd.exe", ["/c", "start", "", VSCODE_PAGE], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { ok: true };
}
