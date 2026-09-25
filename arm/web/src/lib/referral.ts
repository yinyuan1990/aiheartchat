"use client";

import { isAddress } from "viem";

/**
 * Arm promoter referrals, browser side. A promoter shares any page with `?ref=<wallet>`; the first ref a browser sees
 * is kept (first touch) until the visitor connects a wallet and signs the binding (see components/referral).
 * The indexer stores the binding once and never changes it.
 */
const KEY = "arm.ref";

export function captureRef() {
  if (typeof window === "undefined") return;
  const q = new URLSearchParams(window.location.search).get("ref");
  if (q && isAddress(q) && !localStorage.getItem(KEY)) localStorage.setItem(KEY, q.toLowerCase());
}

export const storedRef = () => (typeof window === "undefined" ? null : localStorage.getItem(KEY));
export const clearRef = () => typeof window !== "undefined" && localStorage.removeItem(KEY);

/** Must match indexer/src/referral.ts bindMessage byte for byte. */
export const bindMessage = (wallet: string, referrer: string, ts: number) =>
  `Arm referral\nwallet: ${wallet.toLowerCase()}\nreferrer: ${referrer.toLowerCase()}\nts: ${ts}`;

/** A promotion link for `me` to any path of the site. */
export const refLink = (me: string, path = "/") =>
  `${typeof window === "undefined" ? "https://arm.yyheart.com" : window.location.origin}${path}${path.includes("?") ? "&" : "?"}ref=${me}`;

/** Promoter pool of one token: creator share (78% of the 1% fee) × referralBps, as a % of the trade. */
export const referralTradePct = (bps: number) => (1 * 0.78 * bps) / 10_000;
