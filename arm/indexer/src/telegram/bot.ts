import { getAddress, isAddress } from "viem";
import { sql, getSync, setSync } from "../db.js";
import { bus } from "../bus.js";
import { isMainnet } from "../config.js";
import { getSettings } from "../hotspots/settings.js";

/**
 * Telegram "buy bot" (9.17, growth module #1).
 *
 * One bot (`TELEGRAM_BOT_TOKEN`) does two jobs:
 *  1. Official channel (`TELEGRAM_CHANNEL`, "@name" or "-100…" id): every new launch + every buy ≥ settings.tgChannelMinBuyUsd.
 *  2. Community groups: anyone with admin rights adds the bot to their group (token page → t.me/<bot>?startgroup=<token>)
 *     and the bot posts that token's buys there, each with Buy / Chart / Explorer buttons (Buy → our token page).
 *
 * Plain Bot API over fetch (no library): long-polling `getUpdates` for commands, `sendPhoto` / `sendMessage` for posts.
 * Trades arrive over the in-process bus from the indexer; anything older than a few minutes (historical replay after a
 * re-index) is ignored so a `--reset-db` never floods the groups. Without a token the module is inert.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHANNEL = process.env.TELEGRAM_CHANNEL ?? "";
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `https://${(process.env.PUBLIC_DOMAINS ?? "arm.yyheart.com").split(",")[0].trim()}`;
const EXPLORER = isMainnet ? "https://arc-scan.org" : "https://testnet.arcscan.app";
/** replayed history is never announced */
const MAX_AGE_MS = 10 * 60_000;
/** project X account, used for the 𝕏 line when the token has none (same handle as web `site.ts`) */
const PROJECT_X = "https://x.com/yinyuan659";
/** minimum spacing between posts to the same chat (Telegram allows ~20/min per group) */
const PER_CHAT_GAP_MS = 3_000;
const QUEUE_MAX = 300;

export const tgConfigured = TOKEN.length > 0;

type BotUser = { id: number; username: string };
let bot: BotUser | null = null;
let lastPoll: string | null = null;
let lastError: string | null = null;

type LogEntry = { ts: string; kind: "sent" | "cmd" | "error" | "info"; chat?: string; detail: string };
const log: LogEntry[] = [];
function note(e: Omit<LogEntry, "ts">) {
  log.unshift({ ts: new Date().toISOString(), ...e });
  if (log.length > 200) log.length = 200;
  if (e.kind === "error") lastError = e.detail;
}

/** Public channel handle (without @) when the channel was configured by username; null for numeric ids. */
export const tgChannelHandle = () => (CHANNEL.startsWith("@") ? CHANNEL.slice(1) : null);
export const tgStatus = () => ({ configured: tgConfigured, bot: bot?.username ?? null, channel: tgChannelHandle(), channelSet: CHANNEL.length > 0, lastPoll, lastError, log: log.slice(0, 100) });

// ------------------------------------------------------------------ Bot API

type TgError = Error & { code?: number; retryAfter?: number };

async function tg<T>(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json()) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
  if (!j.ok) {
    const e: TgError = new Error(j.description ?? `telegram ${r.status}`);
    e.code = j.error_code;
    e.retryAfter = j.parameters?.retry_after;
    throw e;
  }
  return j.result as T;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------ formatting

const fmtUsd = (n: number) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `$${n.toPrecision(3)}`;
};
const fmtNum = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n < 10 ? 2 : 0);
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tokenUrl = (a: string) => `${PUBLIC_BASE}/token/${a}`;
const logoUrl = (logo: string | null | undefined): string | null => {
  if (!logo) return null;
  const abs = logo.startsWith("/") ? PUBLIC_BASE + logo : logo;
  if (!/^https:\/\//.test(abs) || /\.svg(\?|$)/i.test(abs)) return null; // Telegram cannot render SVG; emoji: logos have no picture
  return abs;
};

type TokenRow = {
  address: string; name: string; symbol: string; logo: string; deployer: string; hidden: boolean;
  last_mcap6: string; website: string; twitter: string; telegram: string; launch_ts: Date; initial_buy_usdc: string;
};

async function tokenRow(address: string): Promise<TokenRow | null> {
  const [r] = await sql<TokenRow[]>`select address, name, symbol, logo, deployer, hidden, last_mcap6, website, twitter, telegram, launch_ts, initial_buy_usdc from tokens where address = ${address}`;
  return r ?? null;
}
async function holderCount(address: string): Promise<number> {
  const [r] = await sql`select count(*)::int as n from holders where token = ${address} and balance > 0`;
  return Number(r?.n ?? 0);
}

function socialLinks(t: TokenRow): string {
  const parts: string[] = [];
  if (t.website) parts.push(`<a href="${esc(t.website)}">Web</a>`);
  if (t.twitter) parts.push(`<a href="${esc(t.twitter)}">X</a>`);
  if (t.telegram) parts.push(`<a href="${esc(t.telegram)}">TG</a>`);
  return parts.join(" · ");
}

/** Buy Alert title by size (boss, 9.19): < 500 Arm BUY · 500–1,999 BIG BUY · ≥ 2,000 WHALE BUY. */
const buyTitle = (usd: number) => (usd >= 2000 ? "🐋 WHALE BUY" : usd >= 500 ? "🔥 BIG BUY" : "🚀 Arm BUY");
const fmtBuyUsd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Buy Alert (boss's template, 9.19): no 🟢 buy bar; the USDC amount is the first and boldest line; same text for the
 * channel and every group. 𝕏 links to the token's X if it has one, else the project's account.
 */
function buyText(t: TokenRow, d: { usd: number; tokens: number; price: number; mcap: number; wallet: string; tx: string }, holders: number): string {
  const x = t.twitter ? esc(t.twitter) : PROJECT_X;
  return [
    `<b>${buyTitle(d.usd)}</b> · <b>${esc(t.name)} ($${esc(t.symbol)})</b>`,
    ``,
    `💵 <b>${fmtBuyUsd(d.usd)} USDC</b>`,
    `🪙 ${fmtNum(d.tokens)} ${esc(t.symbol)}`,
    ``,
    `💰 Price  ${fmtUsd(d.price)}`,
    `📊 MC     ${fmtUsd(d.mcap)}`,
    `👥 Holders ${holders}`,
    ``,
    `👤 <a href="${EXPLORER}/address/${d.wallet}">${short(d.wallet)}</a>`,
    `🔗 <a href="${EXPLORER}/tx/${d.tx}">Tx</a>`,
    ``,
    `<a href="${x}">𝕏</a>`,
    ``,
    `🚀 <a href="${tokenUrl(t.address)}">Trade on Arm</a>`,
  ].join("\n");
}

function launchText(t: TokenRow, description: string): string {
  const desc = description.trim();
  const lines = [
    `🚀 <b>New launch on Arm</b>`,
    ``,
    `<b>${esc(t.name)} ($${esc(t.symbol)})</b>`,
    ...(desc ? [esc(desc.length > 200 ? `${desc.slice(0, 200)}…` : desc)] : []),
    ``,
    `👤 Creator <a href="${EXPLORER}/address/${t.deployer}">${short(t.deployer)}</a>`,
    `🔒 LP locked forever · 78% of fees to the creator`,
    `📄 <code>${t.address}</code>`,
  ];
  const s = socialLinks(t);
  if (s) lines.push(``, s);
  lines.push(``, `<a href="${tokenUrl(t.address)}">Trade on Arm</a>`);
  return lines.join("\n");
}

const buyKeyboard = (t: TokenRow) => ({
  inline_keyboard: [[
    { text: "🚀 Buy", url: tokenUrl(t.address) },
    { text: "📈 Chart", url: tokenUrl(t.address) },
    { text: "🔍 Explorer", url: `${EXPLORER}/address/${t.address}` },
  ]],
});

// ------------------------------------------------------------------ outbound queue

type Post = { chatId: string | number; text: string; photo: string | null; keyboard?: Record<string, unknown>; token?: string };
const queue: Post[] = [];
const lastSentAt = new Map<string, number>();
let draining = false;

function enqueue(p: Post) {
  queue.push(p);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  if (!draining) void drain();
}

async function drain() {
  draining = true;
  try {
    while (queue.length) {
      const p = queue.shift()!;
      const key = String(p.chatId);
      const wait = (lastSentAt.get(key) ?? 0) + PER_CHAT_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      await send(p);
      lastSentAt.set(key, Date.now());
      await sleep(60); // stay well under the global ~30 msg/s
    }
  } finally {
    draining = false;
  }
}

async function send(p: Post, attempt = 0): Promise<void> {
  try {
    if (p.photo) {
      try {
        await tg("sendPhoto", { chat_id: p.chatId, photo: p.photo, caption: p.text, parse_mode: "HTML", reply_markup: p.keyboard });
      } catch (e) {
        const err = e as TgError;
        if (err.code === 429 || err.code === 403 || /chat not found|kicked|blocked/i.test(err.message)) throw e;
        // bad / unreachable picture → plain text
        await tg("sendMessage", { chat_id: p.chatId, text: p.text, parse_mode: "HTML", reply_markup: p.keyboard, link_preview_options: { is_disabled: true } });
      }
    } else {
      await tg("sendMessage", { chat_id: p.chatId, text: p.text, parse_mode: "HTML", reply_markup: p.keyboard, link_preview_options: { is_disabled: true } });
    }
    note({ kind: "sent", chat: String(p.chatId), detail: p.token ? `buy/launch ${p.token}` : "message" });
  } catch (e) {
    const err = e as TgError;
    if (err.code === 429 && attempt < 2) {
      await sleep(((err.retryAfter ?? 5) + 1) * 1000);
      return send(p, attempt + 1);
    }
    // network-level failure (no Bot API error code, e.g. "fetch failed" / timeout) → back off and retry
    if (err.code === undefined && attempt < 3) {
      await sleep([3_000, 10_000, 30_000][attempt]);
      return send(p, attempt + 1);
    }
    if (err.code === 403 || /chat not found|was kicked|bot was blocked|not enough rights|CHAT_WRITE_FORBIDDEN/i.test(err.message)) {
      // removed from the group / channel → stop trying
      await sql`update tg_subscriptions set active = false where chat_id = ${String(p.chatId)}`.catch(() => {});
      note({ kind: "info", chat: String(p.chatId), detail: `deactivated: ${err.message}` });
      return;
    }
    note({ kind: "error", chat: String(p.chatId), detail: err.message });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ indexer events

async function onTrade(d: { token: string; side: string; usdc: string; tokens: string; price: number; mcap6: string; wallet: string; tx: string; ts: Date | string }) {
  if (d.side !== "buy") return;
  if (Date.now() - new Date(d.ts).getTime() > MAX_AGE_MS) return;
  const usd = Number(d.usdc) / 1e6;
  if (usd <= 0) return;
  const s = await getSettings();
  const subs = await sql<{ chat_id: string; min_buy_usd: number }[]>`select chat_id, min_buy_usd from tg_subscriptions where token = ${d.token} and active`;
  const toChannel = CHANNEL && s.tgEnabled && usd >= s.tgChannelMinBuyUsd;
  const targets = subs.filter((x) => usd >= Number(x.min_buy_usd)).map((x) => x.chat_id);
  if (!toChannel && targets.length === 0) return;
  const t = await tokenRow(d.token);
  if (!t) return;
  const holders = await holderCount(d.token);
  const text = buyText(t, { usd, tokens: Number(d.tokens) / 1e18, price: d.price, mcap: Number(d.mcap6) / 1e6, wallet: d.wallet, tx: d.tx }, holders);
  const photo = s.tgPhotos ? logoUrl(t.logo) : null;
  const kb = buyKeyboard(t);
  if (toChannel && !t.hidden) enqueue({ chatId: CHANNEL, text, photo, keyboard: kb, token: t.symbol });
  for (const chatId of targets) enqueue({ chatId, text, photo, keyboard: kb, token: t.symbol });
}

async function onLaunch(d: { token: string; ts: Date | string }) {
  if (!CHANNEL) return;
  if (Date.now() - new Date(d.ts).getTime() > MAX_AGE_MS) return;
  const s = await getSettings();
  if (!s.tgEnabled || !s.tgLaunches) return;
  const t = await tokenRow(d.token);
  if (!t) return;
  const [row] = await sql<{ description: string }[]>`select description from tokens where address = ${d.token}`;
  enqueue({ chatId: CHANNEL, text: launchText(t, row?.description ?? ""), photo: s.tgPhotos ? logoUrl(t.logo) : null, keyboard: buyKeyboard(t), token: t.symbol });
}

// ------------------------------------------------------------------ commands (long polling)

type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; username?: string };
type TgUser = { id: number; is_bot: boolean; username?: string; first_name?: string };
type TgMessage = { message_id: number; chat: TgChat; from?: TgUser; sender_chat?: TgChat; text?: string; new_chat_members?: TgUser[] };
type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: { chat: TgChat; new_chat_member: { status: string } };
};

const ADMIN_STATUSES = new Set(["creator", "administrator"]);

async function isAdmin(msg: TgMessage): Promise<boolean> {
  if (msg.chat.type === "private") return true;
  // anonymous group admins post as the group itself
  if (msg.sender_chat && msg.sender_chat.id === msg.chat.id) return true;
  if (!msg.from) return false;
  try {
    const m = await tg<{ status: string }>("getChatMember", { chat_id: msg.chat.id, user_id: msg.from.id });
    return ADMIN_STATUSES.has(m.status);
  } catch {
    return false;
  }
}

async function reply(chatId: number, text: string, keyboard?: Record<string, unknown>) {
  await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } }).catch((e) => note({ kind: "error", chat: String(chatId), detail: (e as Error).message }));
}

const HELP = () => [
  `<b>Arm Buy Bot</b> — posts every buy of an Arm token into your group.`,
  ``,
  `<b>Setup</b>: add me to your group as admin, then send`,
  `/track &lt;token address&gt;`,
  ``,
  `<b>Commands</b> (group admins only)`,
  `/track &lt;address&gt; — start posting this token's buys`,
  `/untrack [address] — stop (no address = all)`,
  `/minbuy &lt;usd&gt; — only post buys ≥ this amount (default 0)`,
  `/list — tokens tracked in this group`,
  ``,
  `Tokens: <a href="${PUBLIC_BASE}">${PUBLIC_BASE.replace(/^https?:\/\//, "")}</a>`,
].join("\n");

async function subscribe(chat: TgChat, address: string, by?: number): Promise<string> {
  if (!isAddress(address)) return `That does not look like a token address. Copy it from the token page (CA button).`;
  const a = getAddress(address);
  const t = await tokenRow(a);
  if (!t) return `Unknown token <code>${a}</code>. Only tokens launched on Arm can be tracked.`;
  await sql`insert into tg_subscriptions (chat_id, chat_title, token, added_by) values (${String(chat.id)}, ${chat.title ?? ""}, ${a}, ${by ?? null})
            on conflict (chat_id, token) do update set active = true, chat_title = excluded.chat_title`;
  note({ kind: "cmd", chat: String(chat.id), detail: `track ${t.symbol}` });
  return [
    `✅ Tracking <b>${esc(t.name)} ($${esc(t.symbol)})</b> — every buy will be posted here.`,
    `Use /minbuy 5 to skip buys under 5 USDC, /untrack to stop.`,
    ``,
    `<a href="${tokenUrl(a)}">Token page</a>`,
  ].join("\n");
}

async function handleMessage(msg: TgMessage) {
  const text = (msg.text ?? "").trim();
  if (!text.startsWith("/")) return;
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@[a-z0-9_]+$/i, ""); // "/track@ARKBuyBot" → "/track"
  const chat = msg.chat;

  if (chat.type === "private") {
    if (cmd === "/start" || cmd === "/help") {
      const kb = bot ? { inline_keyboard: [[{ text: "➕ Add me to a group", url: `https://t.me/${bot.username}?startgroup=true` }]] } : undefined;
      await reply(chat.id, HELP(), kb);
    } else await reply(chat.id, `Commands only work inside a group. ${HELP()}`);
    return;
  }
  if (chat.type === "channel") return;

  if (!["/start", "/track", "/untrack", "/minbuy", "/list", "/help"].includes(cmd)) return;
  if (!(await isAdmin(msg))) {
    if (cmd !== "/start") await reply(chat.id, `Only group admins can configure the bot.`);
    return;
  }

  switch (cmd) {
    case "/start": {
      // t.me/<bot>?startgroup=<token> → "/start <token>" arrives in the group right after the bot is added
      if (args[0] && isAddress(args[0])) await reply(chat.id, await subscribe(chat, args[0], msg.from?.id));
      else await reply(chat.id, HELP());
      return;
    }
    case "/help": await reply(chat.id, HELP()); return;
    case "/track": {
      if (!args[0]) return reply(chat.id, `Usage: /track &lt;token address&gt;`);
      await reply(chat.id, await subscribe(chat, args[0], msg.from?.id));
      return;
    }
    case "/untrack": {
      if (args[0] && isAddress(args[0])) {
        await sql`update tg_subscriptions set active = false where chat_id = ${String(chat.id)} and token = ${getAddress(args[0])}`;
      } else {
        await sql`update tg_subscriptions set active = false where chat_id = ${String(chat.id)}`;
      }
      note({ kind: "cmd", chat: String(chat.id), detail: `untrack ${args[0] ?? "all"}` });
      await reply(chat.id, `🛑 Stopped.`);
      return;
    }
    case "/minbuy": {
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n < 0) return reply(chat.id, `Usage: /minbuy &lt;usd&gt; (e.g. /minbuy 5)`);
      const r = await sql`update tg_subscriptions set min_buy_usd = ${n} where chat_id = ${String(chat.id)} and active returning token`;
      if (r.length === 0) return reply(chat.id, `Nothing tracked here yet — /track &lt;address&gt; first.`);
      await reply(chat.id, `✅ Only buys ≥ ${n} USDC will be posted.`);
      return;
    }
    case "/list": {
      const rows = await sql<{ token: string; symbol: string; min_buy_usd: number }[]>`select s.token, t.symbol, s.min_buy_usd from tg_subscriptions s join tokens t on t.address = s.token where s.chat_id = ${String(chat.id)} and s.active order by s.added_at`;
      if (rows.length === 0) return reply(chat.id, `Nothing tracked here. /track &lt;address&gt; to start.`);
      await reply(chat.id, rows.map((r) => `• $${esc(r.symbol)} <code>${r.token}</code> (min ${Number(r.min_buy_usd)} USDC)`).join("\n"));
      return;
    }
  }
}

async function handleUpdate(u: TgUpdate) {
  if (u.my_chat_member) {
    const st = u.my_chat_member.new_chat_member.status;
    if (st === "left" || st === "kicked") {
      await sql`update tg_subscriptions set active = false where chat_id = ${String(u.my_chat_member.chat.id)}`;
      note({ kind: "info", chat: String(u.my_chat_member.chat.id), detail: `removed from chat (${st})` });
    }
    return;
  }
  if (u.message) await handleMessage(u.message);
}

async function pollLoop() {
  let offset = Number((await getSync("tg_offset")) ?? "0");
  for (;;) {
    try {
      const updates = await tg<TgUpdate[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "my_chat_member"] }, 45_000);
      lastPoll = new Date().toISOString();
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => note({ kind: "error", detail: `update: ${(e as Error).message}` }));
      }
      if (updates.length) await setSync("tg_offset", String(offset));
    } catch (e) {
      const err = e as TgError;
      note({ kind: "error", detail: `poll: ${err.message}` });
      if (err.code === 409) await sleep(15_000); // another instance is polling with this token (old container still up)
      else await sleep(5_000);
    }
  }
}

// ------------------------------------------------------------------ admin helpers

/** Owner-triggered test post to the official channel (verifies token + channel rights in one go). */
export async function tgTestChannel(): Promise<{ ok: boolean; error?: string }> {
  if (!tgConfigured) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  if (!CHANNEL) return { ok: false, error: "TELEGRAM_CHANNEL not set" };
  try {
    await tg("sendMessage", { chat_id: CHANNEL, text: `✅ Arm Buy Bot connected · ${new Date().toISOString()}`, link_preview_options: { is_disabled: true } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function tgSubscriptions() {
  const rows = await sql`select s.id, s.chat_id, s.chat_title, s.token, t.symbol, s.min_buy_usd, s.active, s.added_at
    from tg_subscriptions s left join tokens t on t.address = s.token order by s.active desc, s.added_at desc limit 500`;
  return rows.map((r) => ({ id: Number(r.id), chatId: String(r.chat_id), chatTitle: r.chat_title, token: r.token, symbol: r.symbol, minBuyUsd: Number(r.min_buy_usd), active: r.active, addedAt: r.added_at }));
}

// ------------------------------------------------------------------ boot

export async function startTelegram() {
  if (!tgConfigured) return;
  try {
    bot = await tg<BotUser>("getMe", {});
    console.log(`[tg] bot @${bot.username}${CHANNEL ? ` · channel ${CHANNEL}` : " · no channel"}`);
    // group commands menu (best effort)
    await tg("setMyCommands", {
      commands: [
        { command: "track", description: "Post this token's buys here: /track <address>" },
        { command: "untrack", description: "Stop posting (optionally one address)" },
        { command: "minbuy", description: "Only post buys ≥ N USDC" },
        { command: "list", description: "Tokens tracked in this group" },
        { command: "help", description: "How to set up" },
      ],
    }).catch(() => {});
  } catch (e) {
    note({ kind: "error", detail: `getMe: ${(e as Error).message}` });
    console.error("[tg] getMe failed:", (e as Error).message);
  }
  bus.on("ws", (m: { type: string; data: Record<string, unknown> }) => {
    if (m.type === "trade") onTrade(m.data as never).catch((e) => note({ kind: "error", detail: `trade: ${(e as Error).message}` }));
    else if (m.type === "launch") onLaunch(m.data as never).catch((e) => note({ kind: "error", detail: `launch: ${(e as Error).message}` }));
  });
  void pollLoop();
}
