import type { LocalAccount } from "viem";
import { API_BASE } from "@/lib/api";
import { HOSTED_AGENT, approveAgent, newAgent } from "./hl";
import type { AiConfig } from "./ai-trade";

/**
 * AI 托管 client (server side: indexer/src/aibot/bots.ts). The server trades with its own agent key (named
 * HOSTED_AGENT, trade-only, cannot withdraw); every call is authorized by a main-wallet signature over
 * `Arm AI 托管 / 地址 / 时间`, reused for a few minutes.
 */

export const MIN_OI_USD = 50_000_000;
export const MAX_COINS = 3;
export type BotCfg = { coins: string[]; maxLeverage: number; maxPct: number; minConfidence: number; maxLossPct: number };
export const DEFAULT_BOT: BotCfg = { coins: ["BTC"], maxLeverage: 3, maxPct: 20, minConfidence: 65, maxLossPct: 30 };
export type Bot = {
  status: "running" | "paused" | "stopped"; reason: string; agent: string; agentValidUntil: number; ai: { provider: string; model: string };
  cfg: BotCfg; baseEquity: number; lastEquity: number; nextRunAt: number; lastRunAt: number | null; createdAt: number; hasKeys: boolean;
};
export type BotEvent = { id: number; at: number; kind: string; coin: string; text: string; data: Record<string, unknown> | null };
export type BotState = { enabled: boolean; bot: Bot | null; events: BotEvent[] };

export const authMessage = (user: string, ts: number) => `Arm AI 托管\n地址: ${user.toLowerCase()}\n时间: ${ts}`;
let cached: { user: string; ts: number; header: string } | null = null;
async function auth(main: LocalAccount): Promise<string> {
  const user = main.address.toLowerCase();
  if (cached && cached.user === user && Date.now() - cached.ts < 5 * 60_000) return cached.header;
  const ts = Date.now();
  const header = `${ts}.${await main.signMessage!({ message: authMessage(user, ts) })}`;
  cached = { user, ts, header };
  return header;
}

async function call(main: LocalAccount, path: string, body?: unknown): Promise<BotState> {
  const r = await fetch(`${API_BASE}/aibot/${main.address.toLowerCase()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-aibot-auth": await auth(main) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => null)) as (BotState & { error?: string }) | null;
  if (r.status === 401) cached = null;
  if (!r.ok || !j) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

const aiPart = (c: AiConfig) => ({ provider: c.provider, model: c.model, key: c.key, baseUrl: c.baseUrl });

export const botState = (main: LocalAccount) => call(main, "");

/** Main wallet approves a fresh hosted agent (replacing any earlier one of that name), then hands its key to the server */
export async function startBot(main: LocalAccount, cfg: BotCfg, ai: AiConfig): Promise<BotState> {
  const agent = newAgent(HOSTED_AGENT);
  await approveAgent(main, agent);
  return call(main, "/start", { agentKey: agent.key, cfg, ai: aiPart(ai) });
}

export const updateBot = (main: LocalAccount, cfg: BotCfg, ai?: AiConfig) => call(main, "/config", { cfg, ai: ai ? aiPart(ai) : undefined });
export const pauseBot = (main: LocalAccount) => call(main, "/control", { action: "pause" });
export const resumeBot = (main: LocalAccount) => call(main, "/control", { action: "resume" });

/** Server drops its keys; then the main wallet re-approves the name to a throwaway key so the old one is dead on Hyperliquid too */
export async function stopBot(main: LocalAccount, closeAll: boolean): Promise<BotState> {
  const s = await call(main, "/control", { action: "stop", closeAll });
  await approveAgent(main, newAgent(HOSTED_AGENT));
  return s;
}
