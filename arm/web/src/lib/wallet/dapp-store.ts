import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { storeRead as rawGet, storeWrite as rawSet } from "./native";

/**
 * DApp browser state: per-site permissions, recents, favourites, sites whose risk notice was accepted.
 * Inside the App it lives in the shell's native store (the DApp WebView shares this origin's localStorage, so a page
 * of arm.yyheart.com opened as a DApp must not be able to grant itself permissions); browsers fall back to localStorage.
 */

export type SitePerm = { address: Address; chainId: number; at: number };
/** Solana connections are granted separately: connecting a site on EVM does not hand it the Solana address. */
export type SolSitePerm = { address: string; at: number };
export type SiteEntry = { url: string; title?: string; at: number };

type State = {
  perms: Record<string, SitePerm>;
  solPerms: Record<string, SolSitePerm>;
  recents: SiteEntry[];
  favs: SiteEntry[];
  ack: string[];
};

const KEYS: Record<keyof State, string> = { perms: "dapp.perms", solPerms: "dapp.solPerms", recents: "dapp.recents", favs: "dapp.favs", ack: "dapp.ack" };
const EMPTY: State = { perms: {}, solPerms: {}, recents: [], favs: [], ack: [] };
const MAX_RECENTS = 20;

let state: State = EMPTY;
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();

export function loadDappStore(): Promise<void> {
  loaded ??= (async () => {
    const next = { ...EMPTY };
    for (const k of Object.keys(KEYS) as (keyof State)[]) {
      try {
        const v = await rawGet(KEYS[k]);
        if (v) (next as Record<string, unknown>)[k] = JSON.parse(v);
      } catch {}
    }
    state = next;
    subs.forEach((f) => f());
  })();
  return loaded;
}

function update<K extends keyof State>(k: K, v: State[K]) {
  state = { ...state, [k]: v };
  subs.forEach((f) => f());
  void rawSet(KEYS[k], JSON.stringify(v));
}

export const dappState = () => state;

export function useDappStore(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      void loadDappStore();
      return () => subs.delete(f);
    },
    () => state,
    () => EMPTY,
  );
}

export const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
};
export const hostOf = (originOrUrl: string) => {
  try {
    return new URL(originOrUrl).host;
  } catch {
    return originOrUrl;
  }
};

export const getPerm = (origin: string): SitePerm | undefined => state.perms[origin];
export const setPerm = (origin: string, p: SitePerm) => update("perms", { ...state.perms, [origin]: p });
export function revokePerm(origin: string) {
  const next = { ...state.perms };
  delete next[origin];
  update("perms", next);
}

export const getSolPerm = (origin: string): SolSitePerm | undefined => state.solPerms[origin];
export const setSolPerm = (origin: string, p: SolSitePerm) => update("solPerms", { ...state.solPerms, [origin]: p });
export function revokeSolPerm(origin: string) {
  const next = { ...state.solPerms };
  delete next[origin];
  update("solPerms", next);
}

export function addRecent(url: string, title?: string) {
  if (!originOf(url)) return;
  update("recents", [{ url, title, at: Date.now() }, ...state.recents.filter((r) => r.url !== url)].slice(0, MAX_RECENTS));
}
export const clearRecents = () => update("recents", []);

export const isFav = (url: string) => state.favs.some((f) => f.url === url);
/** Returns the new state (true = now a favourite). */
export function toggleFav(url: string, title?: string): boolean {
  if (isFav(url)) {
    update("favs", state.favs.filter((f) => f.url !== url));
    return false;
  }
  update("favs", [{ url, title, at: Date.now() }, ...state.favs]);
  return true;
}

/** Chain picked on the DApp page when a site was opened: its default until it connects or switches (memory only). */
const launchChains = new Map<string, number>();
export const setLaunchChain = (origin: string, chainId: number) => launchChains.set(origin, chainId);
export const launchChainOf = (origin: string) => launchChains.get(origin);

export const isAcked = (origin: string) => state.ack.includes(origin);
export const ackOrigin = (origin: string) => !isAcked(origin) && update("ack", [...state.ack, origin]);

/** Arm's own sites: shown as verified and opened without the risk notice. */
export const TRUSTED_ORIGINS = ["https://arm.yyheart.com"];
export const isTrusted = (origin: string) => TRUSTED_ORIGINS.includes(origin);
