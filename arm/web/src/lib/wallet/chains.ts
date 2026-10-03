import { useSyncExternalStore } from "react";
import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient } from "viem";
import { storeRead, storeWrite } from "./native";
import { arbitrum, base, bsc, mainnet, polygon } from "viem/chains";
import { arcMainnet } from "@/lib/web3";
import { API_BASE } from "@/lib/api";
import { probeSolNode } from "./sol";
import { probeTronNode } from "./tron";

export type StableToken = { symbol: string; address: Address; decimals: number };

export type WalletChain = {
  key: string;
  name: string;
  /** Solana has no EVM chain; `chain` then only carries the node list and the native coin (id 0 never matches a chainId). */
  kind?: "solana" | "tron";
  chain: Chain;
  color: string;
  /** fallback letter when the logo can't load */
  glyph: string;
  /** chain logo bundled in /public (round badge; Trust Wallet / Ave artwork) */
  icon: string;
  /** Arc pays gas in USDC through the 0x3600… precompile; its "native" balance is that same USDC (18 decimals natively, 6 via ERC-20). */
  nativeIsUsdc?: boolean;
  stables: StableToken[];
  explorer: string;
};

const withRpc = (c: Chain, rpc: string[]) => defineChain({ ...c, rpcUrls: { default: { http: rpc } } });

export const WALLET_CHAINS: WalletChain[] = [
  {
    key: "arc",
    name: "Arc",
    chain: arcMainnet,
    color: "#111111",
    glyph: "A",
    icon: "/wallet/chains/arc.png",
    nativeIsUsdc: true,
    stables: [{ symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6 }],
    explorer: "https://arc-scan.org",
  },
  {
    key: "eth",
    name: "Ethereum",
    chain: withRpc(mainnet, ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth", "https://eth.drpc.org"]),
    color: "#627EEA",
    glyph: "Ξ",
    icon: "/wallet/chains/eth.png",
    stables: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    ],
    explorer: "https://etherscan.io",
  },
  {
    key: "bsc",
    name: "BNB Chain",
    chain: withRpc(bsc, ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.binance.org", "https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb"]),
    color: "#F0B90B",
    glyph: "B",
    icon: "/wallet/chains/bsc.png",
    stables: [
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    ],
    explorer: "https://bscscan.com",
  },
  {
    key: "base",
    name: "Base",
    chain: withRpc(base, ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://1rpc.io/base", "https://base.drpc.org"]),
    color: "#0052FF",
    glyph: "b",
    icon: "/wallet/chains/base.png",
    stables: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }],
    explorer: "https://basescan.org",
  },
  {
    key: "arb",
    name: "Arbitrum",
    chain: withRpc(arbitrum, ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://1rpc.io/arb", "https://arbitrum.drpc.org"]),
    color: "#28A0F0",
    glyph: "A",
    icon: "/wallet/chains/arb.png",
    stables: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    ],
    explorer: "https://arbiscan.io",
  },
  {
    key: "polygon",
    name: "Polygon",
    chain: withRpc(polygon, ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic", "https://polygon.drpc.org"]),
    color: "#8247E5",
    glyph: "P",
    icon: "/wallet/chains/polygon.png",
    stables: [
      { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    ],
    explorer: "https://polygonscan.com",
  },
  {
    key: "sol",
    name: "Solana",
    kind: "solana",
    chain: defineChain({
      id: 0,
      name: "Solana",
      nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
      // our relay first: public nodes are slow or unreachable from mainland China, api.mainnet-beta refuses browser
      // origins and publicnode refuses token-account scans (balances of SPL tokens need the relay or a custom node)
      rpcUrls: { default: { http: [`${API_BASE}/sol/rpc`, "https://solana-rpc.publicnode.com"] } },
    }),
    color: "#9945FF",
    glyph: "◎",
    icon: "/wallet/chains/sol.png",
    stables: [],
    explorer: "https://solscan.io",
  },
  {
    key: "trx",
    name: "TRON",
    kind: "tron",
    chain: defineChain({
      id: 728126428,
      name: "TRON",
      nativeCurrency: { name: "TRON", symbol: "TRX", decimals: 6 },
      // a TronGrid-style HTTP API base (…/wallet/*, …/v1/accounts/*): our relay, or a custom TronGrid / own node
      rpcUrls: { default: { http: [`${API_BASE}/trx`] } },
    }),
    color: "#EB0029",
    glyph: "T",
    icon: "/wallet/chains/trx.png",
    stables: [],
    explorer: "https://tronscan.org/#",
  },
];

export const isSolana = (c: WalletChain) => c.kind === "solana";
export const isTron = (c: WalletChain) => c.kind === "tron";
export const isEvm = (c: WalletChain) => !c.kind;
/** Logo of the chain's gas coin: ETH on the L2s, otherwise the chain's own. */
export const nativeIcon = (c: WalletChain) => (c.key === "base" || c.key === "arb" ? "/wallet/chains/eth.png" : c.icon);
export const EVM_CHAINS = WALLET_CHAINS.filter(isEvm);
export const SOL_CHAIN = WALLET_CHAINS.find(isSolana)!;
export const TRON_CHAIN = WALLET_CHAINS.find(isTron)!;
export const chainByKey = (key?: string | null) => WALLET_CHAINS.find((c) => c.key === key) ?? WALLET_CHAINS[0];
export const chainById = (id?: number | null) => EVM_CHAINS.find((c) => c.chain.id === id);
/** Built-in relay URLs are host-relative; show them by name. */
export const nodeLabel = (url: string) => (url === `${API_BASE}/sol/rpc` || url === `${API_BASE}/trx` ? "心之音加速节点" : url.replace(/^https?:\/\//, ""));

// ---------- RPC nodes: built-in list + user-added, one selected per chain (kept in the shell's native store) ----------
type NodeState = { selected: Record<string, string>; custom: Record<string, string[]> };
let nodes: NodeState = { selected: {}, custom: {} };
let nodesLoaded: Promise<void> | null = null;
const nodeSubs = new Set<() => void>();

export function loadNodes(): Promise<void> {
  nodesLoaded ??= (async () => {
    try {
      const v = await storeRead("nodes");
      if (v) nodes = { ...nodes, ...(JSON.parse(v) as Partial<NodeState>) };
    } catch {}
    clients.clear();
    nodeSubs.forEach((f) => f());
  })();
  return nodesLoaded;
}

function saveNodes(next: NodeState) {
  nodes = next;
  clients.clear();
  nodeSubs.forEach((f) => f());
  void storeWrite("nodes", JSON.stringify(next));
}

export const builtinNodes = (c: WalletChain) => c.chain.rpcUrls.default.http;
export const nodesOf = (c: WalletChain) => [...builtinNodes(c), ...(nodes.custom[c.key] ?? [])];
export const isCustomNode = (c: WalletChain, url: string) => !!nodes.custom[c.key]?.includes(url);
/** The node every wallet read / send on this chain goes through. */
export function rpcOf(c: WalletChain): string {
  const s = nodes.selected[c.key];
  return s && nodesOf(c).includes(s) ? s : builtinNodes(c)[0];
}
export const selectNode = (c: WalletChain, url: string) => saveNodes({ ...nodes, selected: { ...nodes.selected, [c.key]: url } });
export function addNode(c: WalletChain, url: string) {
  if (nodesOf(c).includes(url)) return selectNode(c, url);
  saveNodes({ selected: { ...nodes.selected, [c.key]: url }, custom: { ...nodes.custom, [c.key]: [...(nodes.custom[c.key] ?? []), url] } });
}
export function removeNode(c: WalletChain, url: string) {
  const selected = { ...nodes.selected };
  if (selected[c.key] === url) delete selected[c.key];
  saveNodes({ selected, custom: { ...nodes.custom, [c.key]: (nodes.custom[c.key] ?? []).filter((u) => u !== url) } });
}
export function useNodes(): NodeState {
  return useSyncExternalStore(
    (f) => {
      nodeSubs.add(f);
      void loadNodes();
      return () => nodeSubs.delete(f);
    },
    () => nodes,
    () => nodes,
  );
}

export type NodeProbe = { ms: number; block?: bigint; chainId?: number; error?: string };

async function rpcCall(url: string, method: string, signal: AbortSignal): Promise<string> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { result?: string; error?: { message?: string } };
  if (typeof j.result !== "string") throw new Error(j.error?.message ?? "bad response");
  return j.result;
}

/** Latency of one eth_blockNumber round trip, plus the node's chain id (a custom node must match the chain). */
export async function probeNode(url: string, timeoutMs = 6000): Promise<NodeProbe> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const block = BigInt(await rpcCall(url, "eth_blockNumber", ac.signal));
    const ms = Math.round(performance.now() - t0);
    const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", ac.signal)));
    return { ms, block, chainId };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: ac.signal.aborted ? "超时" : (e as Error).message || "连不上" };
  } finally {
    clearTimeout(timer);
  }
}

/** Same as probeNode for the chain's own RPC dialect; `chainId` is the chain's id when a Solana node is on mainnet. */
export async function probeChainNode(c: WalletChain, url: string, timeoutMs = 6000): Promise<NodeProbe> {
  if (isTron(c)) {
    const t = await probeTronNode(url, timeoutMs);
    return { ms: t.ms, block: t.block != null ? BigInt(t.block) : undefined, chainId: t.block != null ? c.chain.id : undefined, error: t.error ?? (t.block == null ? "不是波场节点" : undefined) };
  }
  if (!isSolana(c)) return probeNode(url, timeoutMs);
  const p = await probeSolNode(url, timeoutMs);
  return { ms: p.ms, block: p.slot != null ? BigInt(p.slot) : undefined, chainId: p.mainnet ? c.chain.id : p.slot != null ? -1 : undefined, error: p.error };
}

const clients = new Map<string, PublicClient>();
export function publicClientFor(c: WalletChain): PublicClient {
  if (!isEvm(c)) throw new Error(`${c.name} has no EVM client`);
  void loadNodes();
  let pc = clients.get(c.key);
  if (!pc) {
    pc = createPublicClient({
      chain: c.chain,
      transport: http(rpcOf(c), { retryCount: 1 }),
      batch: c.chain.contracts?.multicall3 ? { multicall: true } : undefined,
    }) as PublicClient;
    clients.set(c.key, pc);
  }
  return pc;
}

export const explorerTx = (c: WalletChain, hash: string) => `${c.explorer}/${isTron(c) ? "transaction" : "tx"}/${hash}`;
export const explorerAddr = (c: WalletChain, a: string) => `${c.explorer}/${isSolana(c) ? "account" : "address"}/${a}`;
export const explorerToken = (c: WalletChain, t: string) => `${c.explorer}/token/${t}`;
