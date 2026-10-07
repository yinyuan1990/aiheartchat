/**
 * 「USDC 生息」 data for the wallet: Morpho vaults on Base. Only rates / sizes / a user's earnings come from here — the
 * vault list itself is pinned in the wallet (lib/wallet/earn.ts) and balances are read on-chain, so this relay can't
 * redirect a deposit. Morpho's public GraphQL API needs no key; mainland users can't always reach it, hence the relay.
 */

const API = "https://api.morpho.org/graphql";
const BASE = 8453;
/** keep in sync with VAULTS in arm/web/src/lib/wallet/earn.ts */
export const EARN_VAULTS = ["0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183"];

export type EarnVault = { address: string; name: string; netApy: number | null; apy: number | null; fee: number | null; tvlUsd: number | null; liquidityUsd: number | null };
export type EarnPosition = { vault: string; assets: string; pnl: string };

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  try {
    const v = await load();
    cache.set(key, { at: Date.now(), v });
    if (cache.size > 5_000) for (const [k, e] of cache) if (Date.now() - e.at > 600_000) cache.delete(k);
    return v;
  } catch (e) {
    if (hit) return hit.v as T;
    throw e;
  }
}

async function gql<T>(query: string): Promise<{ data?: T; errors?: { message: string }[] }> {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`morpho ${r.status}`);
  return (await r.json()) as { data?: T; errors?: { message: string }[] };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const earnVaults = () =>
  cached("vaults", 5 * 60_000, async () => {
    const list = EARN_VAULTS.map((a) => `"${a}"`).join(",");
    const j = await gql<{ vaults: { items: { address: string; name: string; state: Record<string, unknown> | null; liquidity: { usd?: number } | null }[] } }>(
      `{ vaults(first: 10, where: { chainId_in: [${BASE}], address_in: [${list}] }) { items { address name state { netApy avgNetApy apy fee totalAssetsUsd } liquidity { usd } } } }`,
    );
    const items = j.data?.vaults.items;
    if (!items?.length) throw new Error(j.errors?.[0]?.message ?? "morpho: no vaults");
    return EARN_VAULTS.flatMap((addr): EarnVault[] => {
      const v = items.find((x) => x.address.toLowerCase() === addr.toLowerCase());
      if (!v) return [];
      const s = v.state ?? {};
      return [{ address: addr, name: v.name, netApy: num(s.avgNetApy) ?? num(s.netApy), apy: num(s.apy), fee: num(s.fee), tvlUsd: num(s.totalAssetsUsd), liquidityUsd: num(v.liquidity?.usd) }];
    });
  });

/** A user's positions in our vaults; `pnl` is Morpho's lifetime earnings in USDC base units (6 decimals). */
export const earnPositions = (user: string) =>
  cached(`pos:${user.toLowerCase()}`, 30_000, async () => {
    const j = await gql<{ userByAddress: { vaultPositions: { vault: { address: string }; state: { assets: number | string; pnl: number | string } | null }[] } | null }>(
      `{ userByAddress(address: "${user}", chainId: ${BASE}) { vaultPositions { vault { address } state { assets pnl } } } }`,
    );
    // an address that never touched Morpho comes back as an error, not an empty list
    const rows = j.data?.userByAddress?.vaultPositions ?? [];
    const ours = new Set(EARN_VAULTS.map((a) => a.toLowerCase()));
    return rows
      .filter((p) => ours.has(p.vault.address.toLowerCase()) && p.state)
      .map((p): EarnPosition => ({ vault: p.vault.address, assets: BigInt(Math.round(Number(p.state!.assets))).toString(), pnl: BigInt(Math.round(Number(p.state!.pnl))).toString() }));
  });
