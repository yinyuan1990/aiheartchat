import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { arc, arcTestnet, bsc } from "viem/chains";
import { defineChain, parseAbi, type Address } from "viem";
import mainnetDeployments from "./deployments.arc-mainnet.json";
import testnetDeployments from "./deployments.arc-testnet.json";

/**
 * viem ships `arc` (5042) without an RPC / explorer.
 * 9.16: official public RPC went live with the mainnet launch; Arcscan's router stays as fallback (Cloudflare-fronted, some
 * wallets in CN fail to reach it). LI.FI's arc-rpc.transferto.xyz answers HTML — dropped.
 */
export const arcMainnet = defineChain({
  ...arc,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io", "https://rpc.arc-scan.org"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://arc-scan.org" } }, // mainnet explorer (arcscan.app is testnet-only)
});
// BSC is used only by the /tools cross-chain swap (boss 9.15: BNB ⇄ Arc USDC, non-custodial via LI.FI).
export const bscChain = defineChain({ ...bsc, rpcUrls: { default: { http: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.binance.org"] } } });

// Mainnet (5042) since 2026-09-16; `NEXT_PUBLIC_NETWORK=testnet` at build time keeps the old testnet deployment for local dev.
export const IS_TESTNET = process.env.NEXT_PUBLIC_NETWORK === "testnet";
export const NET = IS_TESTNET ? "testnet" : "mainnet";
export const chain = IS_TESTNET ? arcTestnet : arcMainnet;
const deployments = IS_TESTNET ? testnetDeployments : mainnetDeployments;
export const EXPLORER = chain.blockExplorers?.default.url ?? "https://arc-scan.org";

/** Current-generation addresses: new launches go here. */
export const ADDR = {
  usdc: deployments.usdc as Address,
  factory: deployments.launchFactory as Address,
  locker: deployments.feeLocker as Address,
  treasury: deployments.treasury as Address,
  router: deployments.swapRouter as Address,
  quoter: deployments.quoterV2 as Address,
  positionManager: deployments.positionManager as Address,
  referralHub: (deployments as { referralHub?: string }).referralHub as Address | undefined,
};

/**
 * Earlier factory generations (9.16: the first mainnet factory used our own Uniswap V3 core; the current one sits on
 * the official Uniswap V3 so wallets / aggregators see the pools). Tokens keep the locker / router of the generation
 * that launched them — LP is locked there forever — so every per-token call must go through `addrsFor(token.factory)`.
 */
type ContractSet = { launchFactory: string; feeLocker: string; swapRouter: string; quoterV2: string };
/** Stock generation (9.18): pools quoted in a whitelisted tokenized stock; payouts still USDC. Absent until deployed. */
export type QuoteAsset = { symbol: string; address: Address; decimals: number; usdcFee: number; usdcPool: Address };
type StockSet = ContractSet & { quoteOracle: string; quotes: Record<string, Omit<QuoteAsset, "symbol">> };
const stock = (deployments as { stock?: StockSet }).stock;
export const STOCK = stock
  ? { factory: stock.launchFactory as Address, locker: stock.feeLocker as Address, oracle: stock.quoteOracle as Address }
  : null;
/** Whitelisted quote assets (from the deployments file; /api/quotes adds live prices). */
export const QUOTES: QuoteAsset[] = Object.entries(stock?.quotes ?? {}).map(([symbol, q]) => ({ symbol, ...q, address: q.address as Address, usdcPool: q.usdcPool as Address }));
export const quoteBySymbol = (s?: string | null) => QUOTES.find((q) => q.symbol === s);
/**
 * Whether /create offers the stock quote-asset picker (9.18 boss: hide until the mainnet smoke passes). Build-time flag:
 * `NEXT_PUBLIC_STOCK_LAUNCH=1` turns it on. Trading / badges for already-launched stock tokens are unaffected.
 */
export const STOCK_LAUNCH_UI = !!STOCK && QUOTES.length > 0 && process.env.NEXT_PUBLIC_STOCK_LAUNCH === "1";

const LEGACY: ContractSet[] = ((deployments as { legacy?: ContractSet[] }).legacy) ?? [];
const SETS: ContractSet[] = [deployments, ...(stock ? [stock] : []), ...LEGACY];
export const LEGACY_FACTORIES = LEGACY.map((s) => s.launchFactory as Address);
export function addrsFor(factory?: string | null) {
  const s = (factory && SETS.find((x) => x.launchFactory.toLowerCase() === factory.toLowerCase())) || SETS[0];
  return { factory: s.launchFactory as Address, locker: s.feeLocker as Address, router: s.swapRouter as Address, quoter: s.quoterV2 as Address };
}
export const isLegacyFactory = (factory?: string | null) => !!factory && LEGACY_FACTORIES.some((f) => f.toLowerCase() === factory.toLowerCase());
export const isStockFactory = (factory?: string | null) => !!STOCK && !!factory && factory.toLowerCase() === STOCK.factory.toLowerCase();

export const POOL_FEE = 10_000;
export const SUPPLY_TOKENS = 1_000_000_000;

// WalletConnect needs a (free) project id from dashboard.reown.com; enabled only when provided.
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID;
// the site is served on several domains; the wallet metadata must name the one the user is actually on
const SITE_ORIGIN = typeof window !== "undefined" ? window.location.origin : (process.env.NEXT_PUBLIC_SITE_URL ?? "https://arm.yyheart.com");

export const wagmiConfig = createConfig({
  // Single-chain on purpose: with extra chains registered, wagmi would route reads to whatever chain the wallet sits
  // on. /tools talks to BSC / Arc mainnet through its own viem clients on the connector's provider (lib/lifi.ts).
  chains: [chain],
  // EIP-6963 discovery (default on) adds every installed browser wallet as its own connector.
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: "Arm", preference: "all" }),
    ...(WC_PROJECT_ID ? [walletConnect({ projectId: WC_PROJECT_ID, showQrModal: true, metadata: { name: "Arm", description: "Community launchpad on the Arc network, settled in USDC", url: SITE_ORIGIN, icons: [`${SITE_ORIGIN}/brand/logo-navy.png`] } })] : []),
  ],
  transports: { [arcMainnet.id]: http(arcMainnet.rpcUrls.default.http[0]), [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const factoryAbi = parseAbi([
  "struct Socials { string website; string twitter; string telegram; string discord; string farcaster; }",
  "struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address payout; uint16 buyTaxBps; uint16 sellTaxBps; address marketingWallet; address teamWallet; uint16 marketingBps; uint256 initialBuyUsdc; uint256 minTokensOut; uint16 referralBps; }",
  "function maxTaxBps() view returns (uint16)",
  "function launch(LaunchParams p) returns (address token, address pool, uint256 positionId)",
  "function creationFee() view returns (uint256)",
  "function startMcapUsdc() view returns (uint256)",
  "function graduationStatus(address token) view returns (uint256 paired, uint256 threshold, bool graduated)",
  "function markGraduated(address token)",
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed pool, uint256 positionId, bool isToken0, uint256 restrictionsEndBlock, uint256 graduationThreshold, uint256 initialBuyUsdc, uint256 creationFeePaid)",
  "function owner() view returns (address)",
]);

/** StockLaunchFactory: LaunchParams carries the quote asset; the first buy is still paid in USDC. */
export const stockFactoryAbi = parseAbi([
  "struct Socials { string website; string twitter; string telegram; string discord; string farcaster; }",
  "struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address payout; uint16 buyTaxBps; uint16 sellTaxBps; address marketingWallet; address teamWallet; uint16 marketingBps; address quote; uint256 initialBuyUsdc; uint256 minTokensOut; }",
  "function launch(LaunchParams p) returns (address token, address pool, uint256 positionId)",
  "function quotes(address quote) view returns (bool enabled, uint24 usdcFee, address usdcPool, uint8 decimals)",
  "function quotePriceUsdc(address quote) view returns (uint256 twapPrice, uint256 spotPrice)",
  "function launchQuotes(address token) view returns (address quote, uint24 usdcFee, uint8 decimals, uint256 priceUsdc)",
  "function graduationStatus(address token) view returns (uint256 paired, uint256 threshold, bool graduated)",
  "function enableQuote(address quote, uint24 usdcFee)",
  "function disableQuote(address quote)",
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed pool, uint256 positionId, bool isToken0, uint256 restrictionsEndBlock, uint256 graduationThreshold, uint256 initialBuyUsdc, uint256 creationFeePaid)",
  "event TokenQuoted(address indexed token, address indexed quote, uint24 usdcFee, uint8 quoteDecimals, uint256 quotePriceUsdc)",
  "function owner() view returns (address)",
]);

export const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  // multi-hop (path = tokenIn · fee · mid · fee · tokenOut, packed); used by /tools swap for token ⇄ token via USDC
  "struct ExactInputParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
]);

export const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

/** Uniswap V3 fee tiers probed by the /tools swap when looking for a pool between two arbitrary Arc tokens. */
export const FEE_TIERS = [100, 500, 3000, 10_000] as const;

export const lockerAbi = parseAbi([
  "function claimable(address account, address asset) view returns (uint256)",
  "function claim(address asset)",
  "function distribute(address token, uint256 minUsdcOut) returns (uint256 usdcCollected, uint256 usdcFromToken)",
  "function setPayout(address token, address newPayout)",
  "function owner() view returns (address)",
]);

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
