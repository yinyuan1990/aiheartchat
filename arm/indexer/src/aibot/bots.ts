import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { verifyMessage, type Hex } from "viem";
import { sql } from "../db.js";
import { AiError, analyze, ping, readLimits, type AiCfg } from "./analyze.js";
import { authMessage } from "./auth.js";
import { MIN_NOTIONAL, plan } from "./plan.js";
import { account, agentAccount, agentDead, agentListed, assets, builderOk, cancelReduceOnly, closePosition, isAddress, openPosition, setLeverage, type HlAccount, type HlAsset } from "./hl.js";

/**
 * AI 托管 (wallet plan §5.8): every 15 minutes the server asks the user's own LLM about each coin they picked and trades
 * within their limits using a hosted Hyperliquid **agent key** — it can open / close positions but can never withdraw, so
 * the money stays in the user's Hyperliquid account. Agent key + LLM key are sealed with AES-GCM under AI_BOT_SECRET
 * (server env only; without it 托管 is off). Every control call is signed by the user's main wallet.
 */

const SECRET = process.env.AI_BOT_SECRET ?? "";
const EVERY_MS = 15 * 60_000;
const TICK_MS = 20_000;
const PARALLEL = 4;
/** only liquid markets: an agent key that leaked could otherwise be used to trade a user's margin away in a thin book */
export const MIN_OI_USD = 50_000_000;
const MAX_COINS = 3;
const MAX_ERRORS = 6;
const EVENTS_KEEP = 500;
const AUTH_WINDOW_MS = 10 * 60_000;

export type BotCfg = { coins: string[]; maxLeverage: number; maxPct: number; minConfidence: number; maxLossPct: number };
type Secret = { agentKey: Hex; ai: { provider: string; model: string; key: string; baseUrl?: string } };
type Row = {
  user_addr: string; status: "running" | "paused" | "stopped"; reason: string; agent_addr: string; agent_valid_until: string;
  secret: string | null; ai_provider: string; ai_model: string; cfg: BotCfg; base_equity: number; last_equity: number; errors: number;
  next_run_at: Date; last_run_at: Date | null; created_at: Date;
};
type Reply = { status: number; json: unknown };

export async function ensureAiBotTables() {
  await sql`create table if not exists ai_bots (
    user_addr text primary key,
    status text not null,
    reason text not null default '',
    agent_addr text not null default '',
    agent_valid_until bigint not null default 0,
    secret text,
    ai_provider text not null default '',
    ai_model text not null default '',
    cfg jsonb not null,
    base_equity double precision not null default 0,
    last_equity double precision not null default 0,
    errors int not null default 0,
    next_run_at timestamptz not null default now(),
    last_run_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await sql`create table if not exists ai_bot_events (
    id bigserial primary key,
    user_addr text not null,
    at timestamptz not null default now(),
    kind text not null,
    coin text not null default '',
    text text not null default '',
    data jsonb
  )`;
  await sql`create index if not exists ai_bot_events_user on ai_bot_events (user_addr, id desc)`;
}

// ---------- sealing ----------

const sealKey = () => createHash("sha256").update(SECRET).digest();
function seal(v: Secret, user: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(), iv);
  c.setAAD(Buffer.from(user));
  const ct = Buffer.concat([c.update(JSON.stringify(v), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function unseal(s: string, user: string): Secret {
  const b = Buffer.from(s, "base64");
  const d = createDecipheriv("aes-256-gcm", sealKey(), b.subarray(0, 12));
  d.setAAD(Buffer.from(user));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as Secret;
}

// ---------- auth: the main wallet signs `Arm AI 托管 / 地址 / 时间` ----------

async function authed(user: string, header: string | undefined): Promise<boolean> {
  const [ts, sig] = (header ?? "").split(".");
  const t = Number(ts);
  if (!isAddress(user) || !Number.isFinite(t) || Math.abs(Date.now() - t) > AUTH_WINDOW_MS || !/^0x[0-9a-fA-F]{130}$/.test(sig ?? "")) return false;
  return verifyMessage({ address: user as Hex, message: authMessage(user, t), signature: sig as Hex }).catch(() => false);
}

// ---------- helpers ----------

async function event(user: string, kind: string, coin: string, text: string, data?: unknown) {
  await sql`insert into ai_bot_events (user_addr, kind, coin, text, data) values (${user}, ${kind}, ${coin}, ${text.slice(0, 500)}, ${data ? sql.json(data as never) : null})`;
}
async function pause(user: string, reason: string) {
  await sql`update ai_bots set status = 'paused', reason = ${reason}, updated_at = now() where user_addr = ${user}`;
  await event(user, "pause", "", reason);
}
const usd = (n: number) => `$${n.toFixed(2)}`;
const side = (s: string) => (s === "long" ? "多" : "空");

async function readCfg(b: unknown, list: HlAsset[]): Promise<BotCfg> {
  const o = (b ?? {}) as Record<string, unknown>;
  const coins = [...new Set((Array.isArray(o.coins) ? o.coins : []).map(String))].slice(0, MAX_COINS);
  if (!coins.length) throw new Error("至少选一个币");
  for (const c of coins) {
    const a = list.find((x) => x.name === c);
    if (!a) throw new Error(`没有 ${c} 这个合约`);
    if (a.oi < MIN_OI_USD) throw new Error(`${c} 流动性不够，托管只做持仓量 5000 万美元以上的币`);
  }
  const lossRaw = typeof o.maxLossPct === "number" && Number.isFinite(o.maxLossPct) ? o.maxLossPct : 30;
  return { coins, ...readLimits(o), maxLossPct: Math.min(90, Math.max(5, lossRaw)) };
}
function readAi(b: unknown): Secret["ai"] {
  const o = (b ?? {}) as Record<string, unknown>;
  const ai = { provider: String(o.provider ?? ""), model: String(o.model ?? "").slice(0, 100), key: String(o.key ?? ""), baseUrl: o.baseUrl ? String(o.baseUrl).slice(0, 300) : undefined };
  if (!ai.key || ai.key.length > 300) throw new Error("没填大模型 API key");
  return ai;
}
async function load(user: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`select * from ai_bots where user_addr = ${user}`;
  return row ?? null;
}
const publicBot = (r: Row | null) =>
  r && {
    status: r.status, reason: r.reason, agent: r.agent_addr, agentValidUntil: Number(r.agent_valid_until), ai: { provider: r.ai_provider, model: r.ai_model },
    cfg: r.cfg, baseEquity: r.base_equity, lastEquity: r.last_equity, nextRunAt: r.next_run_at.getTime(), lastRunAt: r.last_run_at?.getTime() ?? null, createdAt: r.created_at.getTime(), hasKeys: !!r.secret,
  };

async function closeAll(user: string, key: Hex, coins: string[], acct: HlAccount, list: HlAsset[]): Promise<string[]> {
  const agent = agentAccount(key);
  const done: string[] = [];
  for (const p of acct.positions.filter((x) => coins.includes(x.coin))) {
    const a = list.find((x) => x.name === p.coin);
    if (!a) continue;
    await closePosition(agent, a, p);
    await cancelReduceOnly(agent, user, a).catch(() => {});
    done.push(`${p.coin} ${side(p.side)}单（浮盈 ${p.upnl >= 0 ? "+" : ""}${usd(p.upnl)}）`);
  }
  return done;
}

// ---------- API ----------

const lower = (u: string) => u.toLowerCase();
const fail = (status: number, error: string): Reply => ({ status, json: { error } });

export async function botGet(user: string, auth: string | undefined): Promise<Reply> {
  if (!(await authed(user, auth))) return fail(401, "签名无效");
  const u = lower(user);
  const row = await load(u);
  const events = await sql`select id, extract(epoch from at) * 1000 as at, kind, coin, text, data from ai_bot_events where user_addr = ${u} order by id desc limit 60`;
  return { status: 200, json: { enabled: !!SECRET, bot: publicBot(row), events: events.map((e) => ({ ...e, at: Number(e.at), id: Number(e.id) })) } };
}

export async function botStart(user: string, auth: string | undefined, body: unknown): Promise<Reply> {
  if (!SECRET) return fail(503, "服务器还没开启托管");
  if (!(await authed(user, auth))) return fail(401, "签名无效");
  const u = lower(user);
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const key = String(b.agentKey ?? "") as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("交易钥匙格式不对");
    const agentAddr = lower(agentAccount(key).address);
    const list = await assets();
    const cfg = await readCfg(b.cfg, list);
    const ai = readAi(b.ai);
    let [listed, acct, builder] = await Promise.all([agentListed(u, agentAddr), account(u), builderOk(u)]);
    if (!listed.ok) {
      await new Promise((r) => setTimeout(r, 2_000));
      listed = await agentListed(u, agentAddr);
    }
    if (!listed.ok) throw new Error("Hyperliquid 上查不到这把交易钥匙的授权，请重试");
    if (listed.validUntil && listed.validUntil < Date.now() + 86_400_000) throw new Error("交易钥匙授权快到期了，请重新授权");
    if (!builder) throw new Error("还没授权平台手续费");
    if (acct.equity < MIN_NOTIONAL) throw new Error("合约账户里至少要有 11 美元");
    await ping(ai);
    const secret = seal({ agentKey: key, ai }, u);
    await sql`insert into ai_bots (user_addr, status, reason, agent_addr, agent_valid_until, secret, ai_provider, ai_model, cfg, base_equity, last_equity, errors, next_run_at)
      values (${u}, 'running', '', ${agentAddr}, ${listed.validUntil}, ${secret}, ${ai.provider}, ${ai.model}, ${sql.json(cfg as never)}, ${acct.equity}, ${acct.equity}, 0, now())
      on conflict (user_addr) do update set status = 'running', reason = '', agent_addr = excluded.agent_addr, agent_valid_until = excluded.agent_valid_until, secret = excluded.secret,
        ai_provider = excluded.ai_provider, ai_model = excluded.ai_model, cfg = excluded.cfg, base_equity = excluded.base_equity, last_equity = excluded.last_equity, errors = 0, next_run_at = now(), updated_at = now()`;
    await event(u, "start", "", `开启托管：${cfg.coins.join("、")}，杠杆最多 ${cfg.maxLeverage} 倍，单笔最多 ${cfg.maxPct}% 余额，亏 ${cfg.maxLossPct}% 自动停`, { equity: acct.equity });
    return botGet(user, auth);
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}

export async function botUpdate(user: string, auth: string | undefined, body: unknown): Promise<Reply> {
  if (!(await authed(user, auth))) return fail(401, "签名无效");
  const u = lower(user);
  const row = await load(u);
  if (!row?.secret) return fail(404, "没有在托管");
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const cfg = await readCfg(b.cfg, await assets());
    let secret = row.secret;
    let ai = { provider: row.ai_provider, model: row.ai_model };
    if (b.ai) {
      const next = readAi(b.ai);
      await ping(next);
      secret = seal({ ...unseal(row.secret, u), ai: next }, u);
      ai = next;
    }
    await sql`update ai_bots set cfg = ${sql.json(cfg as never)}, secret = ${secret}, ai_provider = ${ai.provider}, ai_model = ${ai.model}, updated_at = now() where user_addr = ${u}`;
    await event(u, "config", "", `修改设置：${cfg.coins.join("、")}，杠杆最多 ${cfg.maxLeverage} 倍，单笔最多 ${cfg.maxPct}% 余额，亏 ${cfg.maxLossPct}% 自动停`);
    return botGet(user, auth);
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}

export async function botControl(user: string, auth: string | undefined, body: unknown): Promise<Reply> {
  if (!(await authed(user, auth))) return fail(401, "签名无效");
  const u = lower(user);
  const row = await load(u);
  if (!row) return fail(404, "没有在托管");
  const b = (body ?? {}) as { action?: string; closeAll?: boolean };
  try {
    if (b.action === "pause") {
      if (row.status !== "running") throw new Error("没有在运行");
      await sql`update ai_bots set status = 'paused', reason = '你手动暂停了', updated_at = now() where user_addr = ${u}`;
      await event(u, "pause", "", "手动暂停");
    } else if (b.action === "resume") {
      if (!row.secret) throw new Error("托管已停止，请重新开启");
      const acct = await account(u);
      await sql`update ai_bots set status = 'running', reason = '', errors = 0, base_equity = ${acct.equity}, next_run_at = now(), updated_at = now() where user_addr = ${u}`;
      await event(u, "resume", "", `继续托管，亏损从现在的 ${usd(acct.equity)} 重新算`);
    } else if (b.action === "stop") {
      let closed: string[] = [];
      if (b.closeAll && row.secret) {
        const [acct, list] = await Promise.all([account(u), assets()]);
        closed = await closeAll(u, unseal(row.secret, u).agentKey, row.cfg.coins, acct, list);
      }
      await sql`update ai_bots set status = 'stopped', reason = '', secret = null, updated_at = now() where user_addr = ${u}`;
      await event(u, "stop", "", closed.length ? `停止托管，已平掉 ${closed.join("、")}，服务器上的钥匙已删除` : "停止托管，服务器上的钥匙已删除");
    } else throw new Error("未知操作");
    return botGet(user, auth);
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}

// ---------- engine ----------

async function trade(user: string, s: Secret, cfg: BotCfg, asset: HlAsset, acct: HlAccount) {
  const ai: AiCfg = { ...s.ai, maxLeverage: cfg.maxLeverage, maxPct: cfg.maxPct, minConfidence: cfg.minConfidence };
  const r = await analyze(ai, asset, acct, "hosted");
  const d = r.decision;
  const pos = acct.positions.find((p) => p.coin === asset.name);
  await event(user, "decision", asset.name, d.summary || d.action, { action: d.action, confidence: d.confidence, leverage: d.leverage, sizePct: d.sizePct, stopLoss: d.stopLoss, takeProfit: d.takeProfit, price: r.price, reasons: d.reasons, risks: d.risks, warnings: r.warnings, usage: r.usage, model: r.model });
  const agent = agentAccount(s.agentKey);

  let p = plan(d, pos, acct.available, asset, cfg, r.atr1h);
  if (p.close && pos) {
    await closePosition(agent, asset, pos);
    await cancelReduceOnly(agent, user, asset).catch(() => {});
    await event(user, "close", asset.name, `平掉${side(pos.side)}单 ${pos.size} ${asset.name}，浮盈 ${pos.upnl >= 0 ? "+" : ""}${usd(pos.upnl)}`, { upnl: pos.upnl });
    if (p.open) p = plan(d, undefined, (await account(user)).available, asset, cfg, r.atr1h);
  }
  if (p.skip) return event(user, "skip", asset.name, p.skip);
  const o = p.open;
  if (!o) return;
  await setLeverage(agent, asset, o.lev);
  await openPosition(agent, asset, o.isLong, o.size, o.tp, o.sl);
  await event(user, "open", asset.name, `开${o.isLong ? "多" : "空"} ${asset.name} ${o.lev}x，保证金 ${usd(o.margin)}，止损 ${o.sl}${o.tp ? `，止盈 ${o.tp}` : ""}`, { side: d.action, lev: o.lev, margin: o.margin, price: asset.mark, sl: o.sl, tp: o.tp });
}

async function run(user: string) {
  const row = await load(user);
  if (!row || row.status !== "running" || !row.secret) return;
  const s = unseal(row.secret, user);
  const cfg = row.cfg;
  if (Number(row.agent_valid_until) && Number(row.agent_valid_until) < Date.now() + 3_600_000) return pause(user, "托管的交易授权快到期了，请在钱包里重新开启托管");
  const [acct, list] = await Promise.all([account(user), assets()]);
  await sql`update ai_bots set last_equity = ${acct.equity}, last_run_at = now() where user_addr = ${user}`;
  if (row.base_equity > 0 && acct.equity < row.base_equity * (1 - cfg.maxLossPct / 100)) {
    const closed = await closeAll(user, s.agentKey, cfg.coins, acct, list).catch((e) => [`平仓失败：${(e as Error).message}`]);
    return pause(user, `亏损超过你设的 ${cfg.maxLossPct}%（${usd(row.base_equity)} → ${usd(acct.equity)}），已暂停${closed.length ? `并平掉 ${closed.join("、")}` : ""}`);
  }
  if (acct.equity < MIN_NOTIONAL && !acct.positions.length) return pause(user, "合约账户余额不足 11 美元，已暂停");

  let errors = row.errors;
  let lastError = "";
  for (const coin of cfg.coins) {
    const asset = list.find((a) => a.name === coin);
    if (!asset) {
      await event(user, "skip", coin, `${coin} 已下架，跳过`);
      continue;
    }
    try {
      await trade(user, s, cfg, asset, acct);
      errors = 0;
    } catch (e) {
      const m = (e as Error).message;
      if ((e instanceof AiError && e.fatal) || agentDead(m)) return pause(user, m);
      errors++;
      lastError = m;
      await event(user, "error", coin, m);
    }
  }
  await sql`update ai_bots set errors = ${errors} where user_addr = ${user}`;
  if (errors >= MAX_ERRORS) await pause(user, `连续出错 ${errors} 次，已暂停：${lastError}`);
  await sql`delete from ai_bot_events where user_addr = ${user} and id < (select id from ai_bot_events where user_addr = ${user} order by id desc offset ${EVENTS_KEEP - 1} limit 1)`;
}

const busy = new Set<string>();
async function tick() {
  const due = await sql<{ user_addr: string }[]>`
    update ai_bots set next_run_at = now() + ${EVERY_MS / 1000} * interval '1 second'
    where user_addr in (select user_addr from ai_bots where status = 'running' and next_run_at <= now() order by next_run_at limit ${PARALLEL * 3})
    returning user_addr`;
  const queue = due.map((d) => d.user_addr).filter((u) => !busy.has(u));
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      busy.add(u);
      try {
        await run(u);
      } catch (e) {
        const m = (e as Error).message;
        console.warn("[aibot]", u.slice(0, 10), m);
        await event(u, "error", "", m).catch(() => {});
      } finally {
        busy.delete(u);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

export function startAiBots() {
  if (!SECRET) return console.log("[aibot] AI_BOT_SECRET not set: 托管 off");
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((e) => console.warn("[aibot] tick", (e as Error).message))
      .finally(() => (running = false));
  }, TICK_MS);
}
