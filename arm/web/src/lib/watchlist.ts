"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Client-only watchlist of token addresses (lowercase), persisted in localStorage. */

const KEY = "arm.watchlist";
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = [];
let cache: readonly string[] | null = null;

function read(): readonly string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: readonly string[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useWatchlist() {
  const list = useSyncExternalStore(subscribe, read, () => EMPTY);
  const has = useCallback((address: string) => list.includes(address.toLowerCase()), [list]);
  const toggle = useCallback((address: string) => {
    const a = address.toLowerCase();
    const cur = read();
    write(cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]);
  }, []);
  return { list, has, toggle };
}
