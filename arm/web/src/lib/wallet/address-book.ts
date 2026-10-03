import { useSyncExternalStore } from "react";
import { getAddress, isAddress } from "viem";
import { storeRead, storeWrite } from "./native";
import { isSolAddress } from "./sol";
import { isTronAddress } from "./tron";

/**
 * Saved contacts and recent recipients. EVM addresses are the same on every EVM chain, so those entries aren't tied to
 * one; Solana (base58) entries only show up while Solana is selected.
 * Native store inside the App (the DApp WebView shares this origin's localStorage), localStorage in browsers.
 */

export type Contact = { address: string; name: string; at: number };

type State = { contacts: Contact[]; recent: string[] };

const KEYS = { contacts: "addressbook", recent: "recent" } as const;
const LEGACY_RECENT = "arm.wallet.recent";
const EMPTY: State = { contacts: [], recent: [] };
const MAX_RECENT = 6;
export const MAX_CONTACTS = 200;
export const MAX_NAME = 20;

/** Checksummed EVM address, or a Solana / TRON address as typed; null when it's none of them. */
export function normalizeAddr(a: string): string | null {
  const s = a.trim();
  if (isAddress(s)) return getAddress(s);
  return isSolAddress(s) || isTronAddress(s) ? s : null;
}
/** Which chain family an entry belongs to (TRON's base58check never decodes to a 32-byte Solana key). */
export const familyOf = (a: string): "evm" | "sol" | "trx" => (a.startsWith("0x") ? "evm" : isTronAddress(a) ? "trx" : "sol");
export const isSolEntry = (a: string) => familyOf(a) === "sol";
export const isTronEntry = (a: string) => familyOf(a) === "trx";

let state: State = EMPTY;
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();

const cleanAddrs = (v: unknown): string[] => (Array.isArray(v) ? v.map((a) => (typeof a === "string" ? normalizeAddr(a) : null)).filter((a): a is string => !!a) : []);
const cleanContacts = (v: unknown): Contact[] =>
  Array.isArray(v)
    ? v
        .filter((c): c is Contact => !!c && typeof c.address === "string" && !!normalizeAddr(c.address) && typeof c.name === "string")
        .map((c) => ({ address: normalizeAddr(c.address)!, name: c.name.slice(0, MAX_NAME), at: Number(c.at) || 0 }))
    : [];

async function readJson(key: string): Promise<unknown> {
  try {
    return JSON.parse((await storeRead(key)) ?? "null");
  } catch {
    return null;
  }
}

export function loadAddressBook(): Promise<void> {
  loaded ??= (async () => {
    const contacts = cleanContacts(await readJson(KEYS.contacts));
    let recent = cleanAddrs(await readJson(KEYS.recent));
    // recipients used to live in localStorage, which DApp pages on this origin can read
    try {
      const legacy = localStorage.getItem(LEGACY_RECENT);
      if (legacy) {
        recent = [...new Set([...recent, ...cleanAddrs(JSON.parse(legacy))])].slice(0, MAX_RECENT);
        void storeWrite(KEYS.recent, JSON.stringify(recent));
        localStorage.removeItem(LEGACY_RECENT);
      }
    } catch {}
    state = { contacts, recent };
    subs.forEach((f) => f());
  })();
  return loaded;
}

function update<K extends keyof State>(k: K, v: State[K]) {
  state = { ...state, [k]: v };
  subs.forEach((f) => f());
  void storeWrite(KEYS[k], JSON.stringify(v));
}

export function useAddressBook(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      void loadAddressBook();
      return () => subs.delete(f);
    },
    () => state,
    () => EMPTY,
  );
}

export const contactOf = (a?: string | null) => {
  const n = a ? normalizeAddr(a) : null;
  return n ? state.contacts.find((c) => c.address === n) : undefined;
};

/** Recent list keeps EVM and Solana recipients apart so each chain still shows up to MAX_RECENT of its own. */
export function pushRecent(a: string) {
  const fam = familyOf(a);
  const rest = state.recent.filter((x) => x !== a);
  const same = [a, ...rest.filter((x) => familyOf(x) === fam)].slice(0, MAX_RECENT);
  update("recent", [...same, ...rest.filter((x) => familyOf(x) !== fam)]);
}

/** Adds or renames; throws with a message the UI can show. */
export function saveContact(address: string, name: string) {
  const n = name.trim().slice(0, MAX_NAME);
  const a = normalizeAddr(address);
  if (!a) throw new Error("地址格式不对");
  if (!n) throw new Error("请填一个名称");
  const rest = state.contacts.filter((c) => c.address !== a);
  if (rest.length >= MAX_CONTACTS) throw new Error(`地址簿最多 ${MAX_CONTACTS} 个`);
  const prev = state.contacts.find((c) => c.address === a);
  update("contacts", [{ address: a, name: n, at: prev?.at ?? Date.now() }, ...rest]);
}

export const removeContact = (a: string) => update("contacts", state.contacts.filter((c) => c.address !== a));
