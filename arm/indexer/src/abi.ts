import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed pool, uint256 positionId, bool isToken0, uint256 restrictionsEndBlock, uint256 graduationThreshold, uint256 initialBuyUsdc, uint256 creationFeePaid)",
  "event Graduated(address indexed token, uint256 pairedUsdc, uint256 threshold)",
  "function graduationStatus(address token) view returns (uint256 paired, uint256 threshold, bool graduated)",
  "function markGraduated(address token)",
  "function creationFee() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function protectionBlocks() view returns (uint256)",
  "function maxHoldBps() view returns (uint16)",
  "function maxBuyBps() view returns (uint16)",
  "function startMcapUsdc() view returns (uint256)",
  "function maxTaxBps() view returns (uint16)",
  "function totalLaunches() view returns (uint256)",
  "function owner() view returns (address)",
]);

/** Arm: one CreatorFeeSplitter per launch, created by the hub and registered as the lock's payout. */
export const hubAbi = parseAbi([
  "event SplitterCreated(address indexed token, address indexed splitter, address indexed creator, uint16 referralBps)",
  "function splitterOf(address token) view returns (address)",
  "function keeper() view returns (address)",
  "function owner() view returns (address)",
]);

export const splitterAbi = parseAbi([
  "event Synced(uint256 received, uint256 toCreator, uint256 toPool, bool creatorPaid)",
  "event ReferralPaid(address indexed referrer, uint256 amount, bool pushed)",
  "event Settled(uint256 poolAmount, uint256 toReferrers, uint256 toCreator, uint256 referrers)",
  "event ReferralBpsChanged(uint16 oldBps, uint16 newBps)",
  "event CreatorChanged(address indexed oldCreator, address indexed newCreator)",
  "function sync()",
  "function settle(uint256 poolAmount, address[] referrers, uint256[] amounts)",
  "function creator() view returns (address)",
  "function referralBps() view returns (uint16)",
  "function pool() view returns (uint256)",
  "function poolSince() view returns (uint256)",
  "function claimable(address) view returns (uint256)",
  "function totalClaimable() view returns (uint256)",
]);

/** Stock generation: same events as the USDC factory (TokenLaunched.graduationThreshold is in quote raw units) plus the
 *  quote-asset surface. `launches` keeps the USDC shape on purpose. */
export const stockFactoryAbi = parseAbi([
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed pool, uint256 positionId, bool isToken0, uint256 restrictionsEndBlock, uint256 graduationThreshold, uint256 initialBuyUsdc, uint256 creationFeePaid)",
  "event TokenQuoted(address indexed token, address indexed quote, uint24 usdcFee, uint8 quoteDecimals, uint256 quotePriceUsdc)",
  "event Graduated(address indexed token, uint256 pairedUsdc, uint256 threshold)",
  "event QuoteSet(address indexed quote, bool enabled, uint24 usdcFee, address usdcPool, uint8 decimals)",
  "function graduationStatus(address token) view returns (uint256 paired, uint256 threshold, bool graduated)",
  "function markGraduated(address token)",
  "function quotes(address quote) view returns (bool enabled, uint24 usdcFee, address usdcPool, uint8 decimals)",
  "function launchQuotes(address token) view returns (address quote, uint24 usdcFee, uint8 decimals, uint256 priceUsdc)",
  "function quotePriceUsdc(address quote) view returns (uint256 twapPrice, uint256 spotPrice)",
  "function startMcapUsdc() view returns (uint256)",
  "function graduationThresholdUsdc() view returns (uint256)",
  "function totalLaunches() view returns (uint256)",
  "function enableQuote(address quote, uint24 usdcFee)",
  "function disableQuote(address quote)",
  "function owner() view returns (address)",
]);

/** StockFeeLocker: events match FeeLocker (amounts are USDC); only `locks` has more fields. */
export const stockLockerAbi = parseAbi([
  "event FeesDistributed(address indexed token, uint256 quoteToCreator, uint256 quoteToProtocol, uint256 tokenConverted, uint256 usdcFromToken, bool creatorPaid)",
  "event TaxDistributed(address indexed token, uint256 tokenConverted, address marketingWallet, uint256 usdcToMarketing, address teamWallet, uint256 usdcToTeam, bool allPaid)",
  "event QuoteFeesDeferred(address indexed token, uint256 amount)",
  "function distribute(address token, uint256 minUsdcOut) returns (uint256 usdcOut, uint256 usdcFromToken)",
  "function locks(address token) view returns (uint256 tokenId, address token_, address quote, uint24 quoteFee, address pool, address quotePool, address creator, address payout, uint16 creatorShareBps, bool exists)",
  "function unconvertedQuoteFees(address token) view returns (uint256)",
  "function unconvertedQuoteTax(address token) view returns (uint256)",
]);

export const lockerAbi = parseAbi([
  "event Locked(address indexed token, uint256 indexed tokenId, address indexed creator, address payout, uint16 creatorShareBps)",
  "event FeesDistributed(address indexed token, uint256 quoteToCreator, uint256 quoteToProtocol, uint256 tokenConverted, uint256 usdcFromToken, bool creatorPaid)",
  "event TokenFeesDeferred(address indexed token, uint256 amount)",
  "event TaxDistributed(address indexed token, uint256 tokenConverted, address marketingWallet, uint256 usdcToMarketing, address teamWallet, uint256 usdcToTeam, bool allPaid)",
  "event Claimed(address indexed account, address indexed asset, uint256 amount)",
  "event PayoutChanged(address indexed token, address indexed oldPayout, address indexed newPayout)",
  "function distribute(address token, uint256 minUsdcOut) returns (uint256 usdcCollected, uint256 usdcFromToken)",
  "function claimable(address account, address asset) view returns (uint256)",
  "function unconvertedTokenFees(address token) view returns (uint256)",
  "function locks(address token) view returns (uint256 tokenId, address token_, address quote, address pool, address creator, address payout, uint16 creatorShareBps, bool exists)",
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
]);

export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function socials() view returns (string website, string twitter, string telegram, string discord, string farcaster)",
  "function taxConfig() view returns (uint16 buyBps, uint16 sellBps, address marketing, address team, uint16 marketingShareBps)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const poolAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const treasuryAbi = parseAbi([
  // v2.10: no on-chain buyback; the 20% goes to the buyback multisig and burns are recorded by hand in /admin
  "event Executed(uint256 usdcToEco, uint256 usdcToBuyback, uint256 usdcToDev)",
  "function execute()",
  "function usdcBalance() view returns (uint256)",
  "function lastExecutedAt() view returns (uint256)",
  "function nextExecuteAt() view returns (uint256)",
  "function pendingRevenue() view returns (uint256)",
  "function INTERVAL() view returns (uint256)",
  "function ecoFund() view returns (address)",
  "function buybackFund() view returns (address)",
  "function devFund() view returns (address)",
  "function totalToEco() view returns (uint256)",
  "function totalToBuyback() view returns (uint256)",
  "function totalToDev() view returns (uint256)",
  "function owner() view returns (address)",
]);

export const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
