import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount, type HDAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { solAddressOf } from "./sol";

/**
 * Self-custody vault: every secret is encrypted together with one wallet password (PBKDF2-SHA256 → AES-GCM-256) and
 * only the ciphertext + public metadata is persisted. Plaintext lives in memory while unlocked.
 */

export type Secret = { kind: "mnemonic"; phrase: string } | { kind: "key"; key: Hex };
/** `sol`: Solana address on Phantom's path (mnemonic wallets only); filled in on first unlock for older vaults. */
export type WalletMeta = { id: string; name: string; kind: Secret["kind"]; address: Address; sol?: string; createdAt: number };
type VaultPlain = { secrets: Record<string, Secret> };
type StoredVault = { v: 1; iter: number; salt: string; iv: string; ct: string; wallets: WalletMeta[]; active: string };

export type Unlocked = { key: CryptoKey; salt: Uint8Array; iter: number; plain: VaultPlain };

const PBKDF2_ITER = 600_000;
const MIN_PASSWORD = 8;

/** Storage backend. The App shell injects `window.ArmWalletNative` (Keystore / Keychain); browsers fall back to localStorage. */
export type VaultStore = { get(): Promise<string | null>; set(v: string): Promise<void>; clear(): Promise<void> };
type MaybePromise<T> = T | Promise<T>;
type NativeBridge = { vaultGet?: () => MaybePromise<string | null>; vaultSet?: (v: string) => MaybePromise<unknown>; vaultClear?: () => MaybePromise<unknown> };

const LS_KEY = "arm.wallet.vault.v1";
export function vaultStore(): VaultStore {
  const native = typeof window !== "undefined" ? (window as unknown as { ArmWalletNative?: NativeBridge }).ArmWalletNative : undefined;
  if (native?.vaultGet && native.vaultSet && native.vaultClear) {
    return {
      get: async () => (await native.vaultGet!()) ?? null,
      set: async (v) => void (await native.vaultSet!(v)),
      clear: async () => void (await native.vaultClear!()),
    };
  }
  return {
    get: async () => localStorage.getItem(LS_KEY),
    set: async (v) => localStorage.setItem(LS_KEY, v),
    clear: async () => localStorage.removeItem(LS_KEY),
  };
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(u: Unlocked, wallets: WalletMeta[], active: string): Promise<StoredVault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, u.key, enc.encode(JSON.stringify(u.plain))));
  return { v: 1, iter: u.iter, salt: b64(u.salt), iv: b64(iv), ct: b64(ct), wallets, active };
}

export async function readStored(store = vaultStore()): Promise<StoredVault | null> {
  const raw = await store.get();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredVault;
    return v.v === 1 && Array.isArray(v.wallets) ? v : null;
  } catch {
    return null;
  }
}

export class WrongPasswordError extends Error {}

export async function unlockVault(password: string, store = vaultStore()): Promise<{ unlocked: Unlocked; wallets: WalletMeta[]; active: string }> {
  const s = await readStored(store);
  if (!s) throw new Error("no vault");
  const salt = unb64(s.salt);
  const key = await deriveKey(password, salt, s.iter);
  let plain: VaultPlain;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) as BufferSource }, key, unb64(s.ct) as BufferSource);
    plain = JSON.parse(dec.decode(pt)) as VaultPlain;
  } catch {
    throw new WrongPasswordError("wrong password");
  }
  return { unlocked: { key, salt, iter: s.iter, plain }, wallets: s.wallets, active: s.active };
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `至少 ${MIN_PASSWORD} 位`;
  return null;
}

/** 0 weak · 1 ok · 2 strong */
export function passwordStrength(pw: string): 0 | 1 | 2 {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 12 && kinds >= 3) return 2;
  if (pw.length >= MIN_PASSWORD && kinds >= 2) return 1;
  return 0;
}

export const newMnemonic = () => generateMnemonic(english);

export function normalizeMnemonic(input: string): string | null {
  const words = input.trim().toLowerCase().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length) || words.some((w) => !english.includes(w))) return null;
  const phrase = words.join(" ");
  try {
    mnemonicToAccount(phrase);
  } catch {
    return null;
  }
  return phrase;
}

export function normalizePrivateKey(input: string): Hex | null {
  const k = (input.trim().startsWith("0x") ? input.trim() : `0x${input.trim()}`) as Hex;
  if (!isHex(k) || k.length !== 66) return null;
  try {
    privateKeyToAccount(k);
  } catch {
    return null;
  }
  return k;
}

export function accountOf(secret: Secret): HDAccount | PrivateKeyAccount {
  return secret.kind === "mnemonic" ? mnemonicToAccount(secret.phrase) : privateKeyToAccount(secret.key);
}

const newId = () => b64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, "");

/** First wallet: creates the vault and its password. */
export async function createVault(password: string, name: string, secret: Secret, store = vaultStore()) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const id = newId();
  const unlocked: Unlocked = { key, salt, iter: PBKDF2_ITER, plain: { secrets: { [id]: secret } } };
  const meta: WalletMeta = { id, name, kind: secret.kind, address: getAddress(accountOf(secret).address), sol: solAddressOf(secret) ?? undefined, createdAt: Date.now() };
  await store.set(JSON.stringify(await seal(unlocked, [meta], id)));
  return { unlocked, wallets: [meta], active: id };
}

/** Further wallets reuse the unlocked key; no password prompt. Returns null if the address is already in the vault. */
export async function addWallet(u: Unlocked, wallets: WalletMeta[], name: string, secret: Secret, store = vaultStore()) {
  const address = getAddress(accountOf(secret).address);
  const dup = wallets.find((w) => w.address === address);
  if (dup) return { duplicate: dup };
  const id = newId();
  const plain: VaultPlain = { secrets: { ...u.plain.secrets, [id]: secret } };
  const next: Unlocked = { ...u, plain };
  const meta: WalletMeta = { id, name, kind: secret.kind, address, sol: solAddressOf(secret) ?? undefined, createdAt: Date.now() };
  const list = [...wallets, meta];
  await store.set(JSON.stringify(await seal(next, list, id)));
  return { unlocked: next, wallets: list, active: id };
}

export async function saveMeta(u: Unlocked, wallets: WalletMeta[], active: string, store = vaultStore()) {
  await store.set(JSON.stringify(await seal(u, wallets, active)));
}

export async function removeWallet(u: Unlocked, wallets: WalletMeta[], id: string, store = vaultStore()) {
  const secrets = { ...u.plain.secrets };
  delete secrets[id];
  const list = wallets.filter((w) => w.id !== id);
  if (list.length === 0) {
    await store.clear();
    return null;
  }
  const next: Unlocked = { ...u, plain: { secrets } };
  await store.set(JSON.stringify(await seal(next, list, list[0].id)));
  return { unlocked: next, wallets: list, active: list[0].id };
}

export async function changePassword(u: Unlocked, wallets: WalletMeta[], active: string, next: string, store = vaultStore()) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(next, salt, PBKDF2_ITER);
  const nu: Unlocked = { key, salt, iter: PBKDF2_ITER, plain: u.plain };
  await store.set(JSON.stringify(await seal(nu, wallets, active)));
  return nu;
}

/** Re-derives from the password (not the cached key) so exporting a secret always asks for it again. */
export async function verifyPassword(password: string, store = vaultStore()): Promise<boolean> {
  try {
    await unlockVault(password, store);
    return true;
  } catch (e) {
    if (e instanceof WrongPasswordError) return false;
    throw e;
  }
}
