import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { app } from "./api.js";
import { migrate } from "./db.js";
import { startIndexer, refreshOnchain } from "./indexer.js";
import { startKeeper } from "./keeper.js";
import { startHotspots, startLogoPainter } from "./hotspots/service.js";
import { startTelegram } from "./telegram/bot.js";
import { startBuyback } from "./buyback.js";
import { bus } from "./bus.js";
import { config } from "./config.js";
import { loadQuotePrices, refreshQuotePrices } from "./quotes.js";

await migrate();
// stock generation: USDC prices of the whitelisted quote assets must be known before the first stock swap is indexed
await loadQuotePrices().catch((e) => console.error("[quotes]", e.message));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[api] listening on :${info.port}`);
});

// WebSocket fan-out of indexer events at /ws
const wss = new WebSocketServer({ server: server as never, path: "/ws" });
wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello", data: { chainId: config.startBlock.toString() } })));
bus.on("ws", (msg) => {
  const s = JSON.stringify(msg, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
});

void startIndexer();
setInterval(() => refreshOnchain().catch((e) => console.error("[refresh]", e.message)), config.refreshMs);
setInterval(() => refreshQuotePrices().catch((e) => console.error("[quotes]", e.message)), config.refreshMs);
if (config.keeper.enabled) void startKeeper();
// AI hotspot crawler; the owner can pause it from /admin (settings.enabled) without a restart.
if ((process.env.HOTSPOTS_ENABLED ?? "true") === "true") {
  void startHotspots();
  void startLogoPainter();
}
// Telegram buy bot (inert without TELEGRAM_BOT_TOKEN)
void startTelegram();
// Automatic buyback & burn from the keeper wallet (idles until the owner enables it in /admin)
void startBuyback();
