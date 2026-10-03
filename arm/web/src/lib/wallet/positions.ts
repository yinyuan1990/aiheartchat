"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { API_BASE } from "@/lib/api";
import { storeRead, storeWrite } from "./native";

// ---------- "N 人在看": this page pings the indexer every 20 s ----------

let sessionId = "";
export function useViewers(key: string): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    sessionId ||= Math.random().toString(36).slice(2, 14).padEnd(8, "0");
    let alive = true;
    const ping = () =>
      fetch(`${API_BASE}/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, id: sessionId }) })
        .then((r) => r.json())
        .then((j: { count?: number }) => alive && typeof j.count === "number" && setN(j.count))
        .catch(() => {});
    void ping();
    const id = setInterval(() => document.visibilityState === "visible" && void ping(), 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key]);
  return n;
}

// ---------- starred coins (kept on the device) ----------

const STAR_KEY = "starred";
let stars: string[] = [];
let starsLoaded: Promise<void> | null = null;
const starSubs = new Set<() => void>();
function loadStars() {
  starsLoaded ??= (async () => {
    try {
      const v = JSON.parse((await storeRead(STAR_KEY)) ?? "[]");
      if (Array.isArray(v)) stars = v.filter((s): s is string => typeof s === "string");
    } catch {}
    starSubs.forEach((f) => f());
  })();
  return starsLoaded;
}
export function useStar(key: string): [boolean, () => void] {
  const all = useSyncExternalStore(
    (f) => {
      starSubs.add(f);
      void loadStars();
      return () => starSubs.delete(f);
    },
    () => stars,
    () => stars,
  );
  const on = all.includes(key);
  return [
    on,
    () => {
      stars = on ? stars.filter((s) => s !== key) : [key, ...stars].slice(0, 300);
      starSubs.forEach((f) => f());
      void storeWrite(STAR_KEY, JSON.stringify(stars));
    },
  ];
}

/**
 * Cost basis for the coin page's position card and the chart's Avg line. Arm and pump coins have the wallet's full
 * trade history from their indexers; EVM tokens only know trades made in this wallet, which are logged here.
 */

export type Fill = { side: "buy" | "sell"; tokens: number; usd: number; at: number; hash?: string };

/** Average-cost method: a sell takes out cost in proportion to the tokens it sells. */
export function costBasis(fills: Fill[]): { qty: number; cost: number; avg: number | null; bought: number } {
  let qty = 0;
  let cost = 0;
  let bought = 0;
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    if (f.side === "buy") {
      qty += f.tokens;
      cost += f.usd;
      bought += f.usd;
    } else if (qty > 0) {
      const part = Math.min(1, f.tokens / qty);
      cost -= cost * part;
      qty = Math.max(0, qty - f.tokens);
    }
  }
  return { qty, cost, avg: qty > 0 && cost > 0 ? cost / qty : null, bought };
}

type Log = Record<string, Fill[]>;
const KEY = "tradeLog";
let log: Log = {};
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();
const k = (chain: string, token: string, owner: string) => `${chain}:${token.toLowerCase()}:${owner.toLowerCase()}`;

function load() {
  loaded ??= (async () => {
    try {
      const v = JSON.parse((await storeRead(KEY)) ?? "{}") as Log;
      if (v && typeof v === "object") log = v;
    } catch {}
    subs.forEach((f) => f());
  })();
  return loaded;
}

export function logFill(chain: string, token: string, owner: string, f: Fill) {
  const key = k(chain, token, owner);
  log = { ...log, [key]: [...(log[key] ?? []).filter((x) => !f.hash || x.hash !== f.hash), f].slice(-200) };
  subs.forEach((s) => s());
  void storeWrite(KEY, JSON.stringify(log));
}

const NONE: Fill[] = [];
export function useFills(chain: string, token: string, owner?: string): Fill[] {
  const all = useSyncExternalStore(
    (f) => {
      subs.add(f);
      void load();
      return () => subs.delete(f);
    },
    () => log,
    () => log,
  );
  return owner ? (all[k(chain, token, owner)] ?? NONE) : NONE;
}
