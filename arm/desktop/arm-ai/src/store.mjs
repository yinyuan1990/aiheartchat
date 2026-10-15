/**
 * Local data of Arm AI in %APPDATA%\ArmAI: the wallet key and the API key are encrypted with Windows DPAPI (only this
 * Windows user on this PC can read them back), caps / ledger / history are plain JSON.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const DIR = process.env.ARM_AI_DIR ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "ArmAI");
mkdirSync(DIR, { recursive: true });
export const file = (name) => join(DIR, name);

const ps = (op, input) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`],
  { input, encoding: "utf8", windowsHide: true }).trim();

/** secrets: DPAPI on Windows; elsewhere (dev only) plain base64 with a warning flag */
export function saveSecret(name, value) {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const win = platform() === "win32";
  writeFileSync(file(name), JSON.stringify({ enc: win ? "dpapi" : "plain", data: win ? ps("Protect", b64) : b64 }));
}
export function loadSecret(name) {
  if (!existsSync(file(name))) return null;
  const j = JSON.parse(readFileSync(file(name), "utf8"));
  const b64 = j.enc === "dpapi" ? ps("Unprotect", j.data) : j.data;
  return Buffer.from(b64, "base64").toString("utf8");
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}
export const writeJson = (name, v) => writeFileSync(file(name), JSON.stringify(v, null, 1));

export const DEFAULT_CAPS = { maxPerCall: 1, dailyCap: 50 };
export function caps() {
  const c = readJson("config.json", {});
  return { maxPerCall: Number(c.maxPerCall ?? DEFAULT_CAPS.maxPerCall), dailyCap: Number(c.dailyCap ?? DEFAULT_CAPS.dailyCap) };
}
export function saveCaps(patch) {
  const c = { ...readJson("config.json", {}), ...patch };
  writeJson("config.json", c);
  return caps();
}

const today = () => new Date().toLocaleDateString("sv");
/** what this app has signed today (micro-USDC): signed is the most it can have cost, so the cap counts it */
export function ledger() {
  const l = readJson("ledger.json", null);
  return l?.day === today() ? l : { day: today(), signed: 0, calls: 0 };
}
export function record(entry) {
  const l = ledger();
  l.signed += entry.amount;
  l.calls += 1;
  writeJson("ledger.json", l);
  if (entry.amount > 0) {
    const f = fees();
    f.signed += entry.amount;
    saveFees(f);
  }
  appendFileSync(file("history.jsonl"), JSON.stringify(entry) + "\n");
}
/** service fee bookkeeping: signed = all signed to BlockRun since this version, paid = fee seen on-chain, pending = signed fee not yet seen */
export function fees() {
  const f = readJson("fees.json", null);
  return { signed: f?.signed ?? 0, paid: f?.paid ?? 0, pending: f?.pending ?? [] };
}
export const saveFees = (f) => writeJson("fees.json", f);
export const recordFee = (entry) => appendFileSync(file("history.jsonl"), JSON.stringify(entry) + "\n");
export function history(limit = 100) {
  try {
    return readFileSync(file("history.jsonl"), "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
