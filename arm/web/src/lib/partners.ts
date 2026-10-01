/** Exchange sign-up links shown on the Tools "AI Perps" tab. Swap in Arm's referral URLs here (they are public anyway). */
export const EXCHANGES: { name: string; url: string; note: "dex" | "cex" }[] = [
  { name: "Hyperliquid", url: "https://app.hyperliquid.xyz/", note: "dex" },
  { name: "Binance", url: "https://www.binance.com/", note: "cex" },
  { name: "OKX", url: "https://www.okx.com/", note: "cex" },
  { name: "Bybit", url: "https://www.bybit.com/", note: "cex" },
  { name: "Bitget", url: "https://www.bitget.com/", note: "cex" },
];

export const NOFX_REPO = "https://github.com/NoFxAiOS/nofx";
export const NOFX_DOCKER = [
  "curl -O https://raw.githubusercontent.com/NoFxAiOS/nofx/main/docker-compose.prod.yml",
  "docker compose -f docker-compose.prod.yml up -d",
].join("\n");
