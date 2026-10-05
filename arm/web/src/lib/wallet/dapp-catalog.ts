import { useSyncExternalStore } from "react";
import { API_BASE } from "@/lib/api";
import { t } from "./i18n";
import { storeRead, storeWrite } from "./native";

/**
 * Recommended DApps for the wallet's DApp page, grouped by category; each site lists the chains it works on
 * (none = every chain). Edited in /admin → DApp (owner-signed, stored by the indexer under `dapp_catalog`); until
 * something is saved there, DEFAULT_CATALOG below is used. Listed sites open without the "unknown site" notice —
 * nothing else; connecting / signing still goes through the confirm sheet.
 */
export type DappItem = { name: string; url: string; desc?: string; icon?: string; chains?: string[] };
export type DappCategory = { id: string; name: string; items: DappItem[] };

export const CATALOG_CHAINS = ["arc", "eth", "bsc", "base", "arb", "polygon"] as const;
const ARM = "https://arm.yyheart.com";

export const DEFAULT_CATALOG: DappCategory[] = [
  {
    id: "arm",
    name: "Arm",
    items: [
      { name: "Arm 首页", url: `${ARM}/`, desc: "免费发币 · 78% 手续费归创作者", icon: "ph:compass", chains: ["arc"] },
      { name: "发币", url: `${ARM}/create`, desc: "几分钟发一个 Arc 代币", icon: "ph:rocket", chains: ["arc"] },
      { name: "游戏探索", url: `${ARM}/games`, desc: "快艇冲冲冲 · 卖在山顶", icon: "ph:game", chains: ["arc"] },
      { name: "排行榜", url: `${ARM}/rank`, desc: "看看谁在赚钱", icon: "ph:trophy", chains: ["arc"] },
    ],
  },
  {
    id: "dex",
    name: "交易",
    items: [
      { name: "Uniswap", url: "https://app.uniswap.org/", desc: "最大的去中心化交易所", chains: ["eth", "base", "arb", "polygon", "bsc"] },
      { name: "PancakeSwap", url: "https://pancakeswap.finance/", desc: "BNB 链主力交易所", chains: ["bsc", "eth", "base", "arb"] },
      { name: "Aerodrome", url: "https://aerodrome.finance/", desc: "Base 链主力交易所", chains: ["base"] },
      { name: "1inch", url: "https://app.1inch.io/", desc: "聚合多家交易所找最优价", chains: ["eth", "bsc", "base", "arb", "polygon"] },
      { name: "CoW Swap", url: "https://swap.cow.fi/", desc: "防夹子的兑换", chains: ["eth", "base", "arb"] },
      { name: "QuickSwap", url: "https://quickswap.exchange/", desc: "Polygon 主力交易所", chains: ["polygon"] },
    ],
  },
  {
    id: "bridge",
    name: "跨链",
    items: [
      { name: "Jumper", url: "https://jumper.exchange/", desc: "跨链聚合（LI.FI）", chains: ["eth", "bsc", "base", "arb", "polygon"] },
      { name: "Across", url: "https://app.across.to/", desc: "快速跨链转账", chains: ["eth", "base", "arb", "polygon", "bsc"] },
      { name: "Stargate", url: "https://stargate.finance/", desc: "稳定币跨链", chains: ["eth", "bsc", "base", "arb", "polygon"] },
    ],
  },
  {
    id: "earn",
    name: "借贷理财",
    items: [
      { name: "Aave", url: "https://app.aave.com/", desc: "存币生息、抵押借款", chains: ["eth", "base", "arb", "polygon", "bsc"] },
      { name: "Lido", url: "https://stake.lido.fi/", desc: "ETH 质押", chains: ["eth"] },
      { name: "Venus", url: "https://app.venus.io/", desc: "BNB 链借贷", chains: ["bsc"] },
      { name: "Morpho", url: "https://app.morpho.org/", desc: "借贷金库", chains: ["eth", "base"] },
    ],
  },
  {
    id: "nft",
    name: "NFT",
    items: [
      { name: "OpenSea", url: "https://opensea.io/", desc: "NFT 交易市场", chains: ["eth", "base", "arb", "polygon"] },
      { name: "Magic Eden", url: "https://magiceden.io/", desc: "多链 NFT 市场", chains: ["eth", "base", "arb", "polygon", "bsc"] },
    ],
  },
  {
    id: "tools",
    name: "工具",
    items: [
      { name: "Revoke.cash", url: "https://revoke.cash/", desc: "查看并撤销代币授权（防盗必备）" },
      { name: "DeBank", url: "https://debank.com/", desc: "多链资产总览", chains: ["eth", "bsc", "base", "arb", "polygon"] },
      { name: "Arcscan", url: "https://arc-scan.org/", desc: "Arc 区块浏览器", chains: ["arc"] },
      { name: "Etherscan", url: "https://etherscan.io/", desc: "以太坊区块浏览器", chains: ["eth"] },
      { name: "BscScan", url: "https://bscscan.com/", desc: "BNB 链区块浏览器", chains: ["bsc"] },
    ],
  },
];

/** Wallet-side translations of the defaults above (the admin panel edits the Chinese originals); applied while a text still equals its default. */
const CATEGORY_KEYS: Record<string, string> = { dex: "cw.dapp.catDex", bridge: "cw.dapp.catBridge", earn: "cw.dapp.catEarn", tools: "cw.dapp.catTools" };
const ITEM_KEYS: Record<string, { name?: string; desc: string }> = {
  [`${ARM}/`]: { name: "cw.dapp.armHome", desc: "cw.dapp.armHomeDesc" },
  [`${ARM}/create`]: { name: "cw.dapp.armCreate", desc: "cw.dapp.armCreateDesc" },
  [`${ARM}/games`]: { name: "cw.dapp.armGames", desc: "cw.dapp.armGamesDesc" },
  [`${ARM}/rank`]: { name: "cw.dapp.armRank", desc: "cw.dapp.armRankDesc" },
  "https://app.uniswap.org/": { desc: "cw.dapp.uniswapDesc" },
  "https://pancakeswap.finance/": { desc: "cw.dapp.pancakeDesc" },
  "https://aerodrome.finance/": { desc: "cw.dapp.aerodromeDesc" },
  "https://app.1inch.io/": { desc: "cw.dapp.oneinchDesc" },
  "https://swap.cow.fi/": { desc: "cw.dapp.cowDesc" },
  "https://quickswap.exchange/": { desc: "cw.dapp.quickswapDesc" },
  "https://jumper.exchange/": { desc: "cw.dapp.jumperDesc" },
  "https://app.across.to/": { desc: "cw.dapp.acrossDesc" },
  "https://stargate.finance/": { desc: "cw.dapp.stargateDesc" },
  "https://app.aave.com/": { desc: "cw.dapp.aaveDesc" },
  "https://stake.lido.fi/": { desc: "cw.dapp.lidoDesc" },
  "https://app.venus.io/": { desc: "cw.dapp.venusDesc" },
  "https://app.morpho.org/": { desc: "cw.dapp.morphoDesc" },
  "https://opensea.io/": { desc: "cw.dapp.openseaDesc" },
  "https://magiceden.io/": { desc: "cw.dapp.magicEdenDesc" },
  "https://revoke.cash/": { desc: "cw.dapp.revokeDesc" },
  "https://debank.com/": { desc: "cw.dapp.debankDesc" },
  "https://arc-scan.org/": { desc: "cw.dapp.arcscanDesc" },
  "https://etherscan.io/": { desc: "cw.dapp.etherscanDesc" },
  "https://bscscan.com/": { desc: "cw.dapp.bscscanDesc" },
};
const DEFAULT_ITEMS = new Map(DEFAULT_CATALOG.flatMap((c) => c.items.map((i) => [i.url, i] as const)));
function localize(cats: DappCategory[]): DappCategory[] {
  return cats.map((c) => {
    const ck = CATEGORY_KEYS[c.id];
    const name = ck && c.name === DEFAULT_CATALOG.find((d) => d.id === c.id)?.name ? t(ck) : c.name;
    const items = c.items.map((i) => {
      const k = ITEM_KEYS[i.url];
      const d = DEFAULT_ITEMS.get(i.url);
      if (!k || !d) return i;
      return { ...i, name: k.name && i.name === d.name ? t(k.name) : i.name, desc: i.desc === d.desc ? t(k.desc) : i.desc };
    });
    return { ...c, name, items };
  });
}

const https = (u: unknown) => {
  try {
    return typeof u === "string" && new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};
/** Drops anything malformed (the server validates too; this keeps a bad cache from breaking the page). */
function sanitize(v: unknown): DappCategory[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((c) => c && typeof c.id === "string" && typeof c.name === "string" && Array.isArray(c.items))
    .map((c) => ({ id: c.id, name: c.name, items: (c.items as DappItem[]).filter((i) => i && typeof i.name === "string" && https(i.url) && (!i.icon || i.icon.startsWith("ph:") || https(i.icon))) }));
  return out.length ? out : null;
}

const CACHE_KEY = "dapp.catalog";
let catalog: DappCategory[] | null = null;
let started = false;
const subs = new Set<() => void>();
const current = () => (catalog ??= localize(DEFAULT_CATALOG));
const set = (c: DappCategory[]) => {
  catalog = localize(c);
  subs.forEach((f) => f());
};

function load() {
  if (started) return;
  started = true;
  void (async () => {
    // native store, not localStorage: arm.yyheart.com pages opened as DApps share this origin's localStorage
    try {
      const cached = sanitize(JSON.parse((await storeRead(CACHE_KEY)) ?? "null"));
      if (cached) set(cached);
    } catch {}
    try {
      const r = await fetch(`${API_BASE}/dapps`);
      if (!r.ok) return;
      const j = (await r.json()) as { categories: unknown };
      const next = j.categories === null ? DEFAULT_CATALOG : sanitize(j.categories);
      if (!next) return;
      set(next);
      void storeWrite(CACHE_KEY, JSON.stringify(next));
    } catch {}
  })();
}

export function useDappCatalog(): DappCategory[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      load();
      return () => subs.delete(f);
    },
    current,
    () => DEFAULT_CATALOG,
  );
}

export const worksOn = (item: DappItem, chainKey: string) => !item.chains?.length || item.chains.includes(chainKey);

/** Categories with only the sites that work on `chainKey`; empty categories dropped. */
export const catalogFor = (cats: DappCategory[], chainKey: string) =>
  cats.map((c) => ({ ...c, items: c.items.filter((i) => worksOn(i, chainKey)) })).filter((c) => c.items.length);

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
/** Whether a site is in the recommended list (any chain). */
export function isListed(origin: string): boolean {
  load();
  return current().some((c) => c.items.some((i) => originOf(i.url) === origin));
}
