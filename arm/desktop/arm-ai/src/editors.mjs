/**
 * Editors Arm AI knows how to find and set up. Each entry: detect() → installs found on this PC, and (optional) the
 * MCP config file it reads. Only Cursor for now; another editor = another entry here.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const ps = (cmd) => {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim();
  } catch {
    return "";
  }
};
const json = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : v ? [v] : [];
  } catch {
    return [];
  }
};
const norm = (p) => p.replace(/^"|"$/g, "").replace(/[\\/]+$/, "");

function versionOf(exe) {
  for (const f of ["resources/app/package.json", "resources/app/product.json"]) {
    try {
      const j = JSON.parse(readFileSync(join(dirname(exe), f), "utf8"));
      if (j.version) return j.version;
    } catch {}
  }
  return null;
}

/** Cursor on Windows: the running process first, then the uninstall registry, then the default install dir */
function detectCursor() {
  if (platform() !== "win32") return [];
  const found = new Map();
  const add = (exe, source) => {
    exe = norm(exe);
    if (!exe || !existsSync(exe)) return;
    const k = exe.toLowerCase();
    const prev = found.get(k);
    if (prev) {
      if (source === "running") prev.running = true;
      return;
    }
    found.set(k, { exe, version: versionOf(exe), running: source === "running", source });
  };
  for (const p of json(ps("Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique | ConvertTo-Json -Compress"))) add(String(p), "running");
  const reg = json(ps("Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Cursor( \\(User\\))?$' } | Select-Object InstallLocation, DisplayIcon | ConvertTo-Json -Compress"));
  for (const r of reg) {
    if (r.InstallLocation) add(join(norm(r.InstallLocation), "Cursor.exe"), "registry");
    if (r.DisplayIcon) add(String(r.DisplayIcon).split(",")[0], "registry");
  }
  add(join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe"), "default");
  // the running one first: that is the one the user actually uses
  return [...found.values()].sort((a, b) => Number(b.running) - Number(a.running));
}

export const editors = [
  {
    id: "cursor",
    name: "Cursor",
    detect: detectCursor,
    mcpFile: () => join(homedir(), ".cursor", "mcp.json"),
    settingsDir: () => join(process.env.APPDATA ?? "", "Cursor", "User"),
  },
];

export const MCP_NAME = "arm-ai";

/** the command line that starts this app as an MCP server (the compiled exe, or node + main.mjs while developing) */
export function mcpCommand() {
  const exe = process.execPath;
  const compiled = !/[\\/](node|bun)(\.exe)?$/i.test(exe);
  return compiled ? { command: exe, args: ["--mcp"] } : { command: exe, args: [join(import.meta.dirname, "main.mjs"), "--mcp"] };
}

export function mcpStatus(editor) {
  const f = editor.mcpFile();
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const e = j.mcpServers?.[MCP_NAME];
    const want = mcpCommand();
    return { file: f, installed: !!e, current: !!e && e.command === want.command && JSON.stringify(e.args) === JSON.stringify(want.args) };
  } catch {
    return { file: f, installed: false, current: false };
  }
}

/** add / update our entry; the old file is copied next to it first */
export function installMcp(editor) {
  const f = editor.mcpFile();
  let j = { mcpServers: {} };
  let backup = null;
  if (existsSync(f)) {
    const raw = readFileSync(f, "utf8");
    try {
      j = JSON.parse(raw || "{}");
    } catch {
      throw new Error(`${f} is not valid JSON; fix or remove it first`);
    }
    backup = `${f}.bak-armai-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(f, backup);
  } else mkdirSync(dirname(f), { recursive: true });
  j.mcpServers ??= {};
  j.mcpServers[MCP_NAME] = mcpCommand();
  writeFileSync(f, JSON.stringify(j, null, 2));
  return { file: f, backup };
}
