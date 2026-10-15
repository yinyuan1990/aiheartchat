/**
 * Editors Arm AI knows how to find. Each entry: detect() → installs found on this PC.
 * `editors` is what the Cursor page shows; `agentHosts` are the VS Code-family editors Cline can be installed into.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
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

/** resources\app of a VS Code-family install; VS Code 1.10x+ keeps it under a per-build folder (<install>\<commit>\…) */
export function appDir(exe) {
  const d = dirname(exe);
  if (existsSync(join(d, "resources", "app", "package.json"))) return join(d, "resources", "app");
  try {
    const subs = readdirSync(d, { withFileTypes: true })
      .filter((s) => s.isDirectory() && existsSync(join(d, s.name, "resources", "app", "package.json")))
      .map((s) => join(d, s.name, "resources", "app"))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return subs[0] ?? null;
  } catch {
    return null;
  }
}

/** product.json (dataFolderName, …) with package.json's version on top, as the Cursor page always showed it */
export function product(exe) {
  const app = appDir(exe);
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(join(app, f), "utf8"));
    } catch {
      return {};
    }
  };
  if (!app) return {};
  const pkg = read("package.json");
  return { ...read("product.json"), ...(pkg.version ? { version: pkg.version } : {}) };
}

/** one PowerShell call for running editors + uninstall entries, shared by every detect() in the same moment */
let scanCache = { at: 0, v: null };
function scan() {
  if (scanCache.v && Date.now() - scanCache.at < 3000) return scanCache.v;
  const out = json(ps(
    // `<editor>.exe …\out\cli.js` is the editor's command line (e.g. our own --install-extension), not the editor running
    "$p = Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe' or Name='Code.exe' or Name='Kiro.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch 'out[\\\\/]cli\\.js' } | Select-Object @{n='t';e={'p'}}, @{n='Path';e={$_.ExecutablePath}} -Unique;" +
      "$r = Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object DisplayName | Select-Object @{n='t';e={'r'}}, DisplayName, InstallLocation, DisplayIcon;" +
      "@($p) + @($r) | ConvertTo-Json -Compress",
  ));
  scanCache = { at: Date.now(), v: { procs: out.filter((x) => x.t === "p").map((x) => String(x.Path)), reg: out.filter((x) => x.t === "r") } };
  return scanCache.v;
}

/** an editor on Windows: the running process first, then the uninstall registry, then the default install dirs */
function finder({ exe: exeName, reg, defaults }) {
  return () => {
    if (platform() !== "win32") return [];
    const { procs, reg: entries } = scan();
    const found = new Map();
    const add = (exe, source) => {
      exe = norm(exe);
      if (!exe || !exe.toLowerCase().endsWith(exeName.toLowerCase()) || !existsSync(exe)) return;
      const k = exe.toLowerCase();
      const prev = found.get(k);
      if (prev) {
        if (source === "running") prev.running = true;
        return;
      }
      found.set(k, { exe, version: product(exe).version ?? null, running: source === "running", source });
    };
    for (const p of procs) add(p, "running");
    for (const r of entries.filter((r) => reg.test(String(r.DisplayName)))) {
      if (r.InstallLocation) add(join(norm(r.InstallLocation), exeName), "registry");
      if (r.DisplayIcon) add(String(r.DisplayIcon).split(",")[0], "registry");
    }
    for (const d of defaults()) add(d, "default");
    // the running one first: that is the one the user actually uses
    return [...found.values()].sort((a, b) => Number(b.running) - Number(a.running));
  };
}

const local = (...p) => join(process.env.LOCALAPPDATA ?? "", ...p);
const programs = (...p) => [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((d) => join(d, ...p));

const cursor = { id: "cursor", name: "Cursor", data: ".cursor", detect: finder({ exe: "Cursor.exe", reg: /^Cursor( \(User\))?$/, defaults: () => [local("Programs", "cursor", "Cursor.exe")] }) };

export const editors = [{ ...cursor, settingsDir: () => join(process.env.APPDATA ?? "", "Cursor", "User") }];

export const agentHosts = [
  { id: "vscode", name: "VS Code", data: ".vscode", detect: finder({ exe: "Code.exe", reg: /^Microsoft Visual Studio Code( \(User\))?$/, defaults: () => [local("Programs", "Microsoft VS Code", "Code.exe"), ...programs("Microsoft VS Code", "Code.exe")] }) },
  cursor,
  { id: "kiro", name: "Kiro", data: ".kiro", detect: finder({ exe: "Kiro.exe", reg: /^Kiro( \(User\))?$/, defaults: () => [local("Programs", "Kiro", "Kiro.exe")] }) },
];
