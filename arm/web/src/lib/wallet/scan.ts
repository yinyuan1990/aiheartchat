import { getAddress, isAddress, type Address } from "viem";
import { isSolAddress } from "./sol";
import { isTonAddress } from "./ton-cell";

/**
 * What a scanned payment QR asks for. Accepts a bare 0x address and EIP-681 links:
 *   ethereum:0xTo[@chainId][?value=<wei>]
 *   ethereum:0xToken[@chainId]/transfer?address=0xTo&uint256=<base units>
 * Amounts stay in base units (`raw`); the caller formats them with the asset's decimals.
 */
export type ScannedPay = { to: Address; chainId?: number; token?: Address; raw?: bigint };

const toBig = (s: string | null): bigint | undefined => {
  if (!s) return undefined;
  try {
    // "1.5e18" is legal in EIP-681
    if (/e/i.test(s)) {
      const [m, e] = s.toLowerCase().split("e");
      const [i, f = ""] = m.split(".");
      const exp = Number(e) - f.length;
      return exp >= 0 ? BigInt(i + f) * 10n ** BigInt(exp) : undefined;
    }
    return /^\d+$/.test(s) ? BigInt(s) : undefined;
  } catch {
    return undefined;
  }
};

/** Solana Pay transfer request (`solana:<recipient>?amount=1.5&spl-token=<mint>`) or a bare base58 address. Amount is decimal, in the coin's own units. */
export type ScannedSol = { to: string; amount?: string; mint?: string };

export function parseScannedSol(text: string): ScannedSol | null {
  const s = text.trim();
  if (isSolAddress(s)) return { to: s };
  const m = s.match(/^solana:([1-9A-HJ-NP-Za-km-z]{32,44})(?:\?(.*))?$/);
  if (!m || !isSolAddress(m[1])) return null;
  const q = new URLSearchParams(m[2] ?? "");
  const amount = q.get("amount");
  const mint = q.get("spl-token");
  return { to: m[1], amount: amount && /^\d+(\.\d+)?$/.test(amount) ? amount : undefined, mint: mint && isSolAddress(mint) ? mint : undefined };
}

/**
 * TON transfer link (Tonkeeper's `ton://transfer/<address>?amount=<nano>&text=<comment>&jetton=<master>`, also its
 * https://app.tonkeeper.com/transfer/… form) or a bare address. `raw` is in base units of GRAM, or of the jetton.
 */
export type ScannedTon = { to: string; raw?: bigint; jetton?: string; text?: string };

export function parseScannedTon(text: string): ScannedTon | null {
  const s = text.trim();
  if (isTonAddress(s)) return { to: s };
  const m = s.match(/^(?:ton:\/\/transfer\/|tonkeeper:\/\/transfer\/|https:\/\/app\.tonkeeper\.com\/transfer\/)([^?#\s]+)(?:\?([^#]*))?/i);
  if (!m || !isTonAddress(m[1])) return null;
  const q = new URLSearchParams(m[2] ?? "");
  const jetton = q.get("jetton");
  const t = q.get("text");
  return { to: m[1], raw: toBig(q.get("amount")), jetton: jetton && isTonAddress(jetton) ? jetton : undefined, text: t ? t.slice(0, 120) : undefined };
}

export function parseScanned(text: string): ScannedPay | null {
  const s = text.trim();
  if (isAddress(s)) return { to: getAddress(s) };
  const m = s.match(/^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/(\w+))?(?:\?(.*))?$/);
  if (m) {
    const target = getAddress(m[1]);
    const chainId = m[2] ? Number(m[2]) : undefined;
    const q = new URLSearchParams(m[4] ?? "");
    if (m[3] === "transfer") {
      const to = q.get("address");
      if (!to || !isAddress(to)) return null;
      return { to: getAddress(to), chainId, token: target, raw: toBig(q.get("uint256")) };
    }
    if (m[3]) return null;
    return { to: target, chainId, raw: toBig(q.get("value")) };
  }
  // other wallets' formats ("address:0x…", a URL with the address in it): take a lone address if there is exactly one
  const all = s.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g);
  if (all && new Set(all.map((a) => a.toLowerCase())).size === 1 && isAddress(all[0])) return { to: getAddress(all[0]) };
  return null;
}
