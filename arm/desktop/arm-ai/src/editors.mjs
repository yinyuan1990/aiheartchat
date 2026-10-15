/**
 * Editors Arm AI knows how to find. Each entry: detect() → installs found on this PC.
 * Only Cursor for now; another editor = another entry here.
 */
import { existsSync, readFileSync } from "node:fs";
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
    settingsDir: () => join(process.env.APPDATA ?? "", "Cursor", "User"),
  },
];
