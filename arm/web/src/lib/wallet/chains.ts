import { useSyncExternalStore } from "react";
import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient } from "viem";
import { storeRead, storeWrite } from "./native";
import { arbitrum, base, bsc, mainnet, polygon } from "viem/chains";
import { arcMainnet } from "@/lib/web3";

export type StableToken = { symbol: string; address: Address; decimals: number };

export type WalletChain = {
  key: string;
  name: string;
  chain: Chain;
  color: string;
  glyph: string;
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
    stables: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }],
    explorer: "https://basescan.org",
  },
  {
    key: "arb",
    name: "Arbitrum",
    chain: withRpc(arbitrum, ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://1rpc.io/arb", "https://arbitrum.drpc.org"]),
    color: "#28A0F0",
    glyph: "A",
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
    stables: [
      { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    ],
    explorer: "https://polygonscan.com",
  },
];

export const chainByKey = (key?: string | null) => WALLET_CHAINS.find((c) => c.key === key) ?? WALLET_CHAINS[0];
export const chainById = (id?: number | null) => WALLET_CHAINS.find((c) => c.chain.id === id);

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

const clients = new Map<string, PublicClient>();
export function publicClientFor(c: WalletChain): PublicClient {
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

export const explorerTx = (c: WalletChain, hash: string) => `${c.explorer}/tx/${hash}`;
export const explorerAddr = (c: WalletChain, a: string) => `${c.explorer}/address/${a}`;
