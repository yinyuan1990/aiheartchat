"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocalAccount } from "viem";
import { GearSix, Pause, Play, Robot, Stop } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { HlAsset } from "@/lib/wallet/hl";
import { providerOf, type AiConfig } from "@/lib/wallet/ai-trade";
import { DEFAULT_BOT, MAX_COINS, MIN_OI_USD, botState, pauseBot, resumeBot, startBot, stopBot, updateBot, type BotCfg, type BotEvent, type BotState } from "@/lib/wallet/aibot";
import { BottomSheet, GhostButton, PrimaryButton } from "./ui";
import { AI_GRADIENT, Slider, Spinner, px, usd } from "./perp-parts";

type Sheet = null | "setup" | "stop";

/** 「AI 托管」 card on /wallet/perp: the server trades for the user every 15 minutes within their limits. */
export function HostedCard({ main, user, list, aiCfg, funded, onNeedAi }: { main: () => LocalAccount; user: string; list: HlAsset[]; aiCfg: AiConfig | null; funded: boolean; onNeedAi: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["aibot", user], queryFn: () => botState(main()), refetchInterval: 30_000, retry: 1 });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState("");
  const st = q.data;
  const bot = st?.bot && st.bot.status !== "stopped" ? st.bot : null;
  const set = (s: BotState) => qc.setQueryData(["aibot", user], s);

  const act = async (name: string, fn: () => Promise<BotState>, ok: string) => {
    setBusy(name);
    try {
      set(await fn());
      toast.success(ok);
      setSheet(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const open = () => {
    if (!aiCfg) return onNeedAi();
    if (!funded) return toast.error("先往合约账户充值");
    setSheet("setup");
  };

  const pnl = bot ? bot.lastEquity - bot.baseEquity : 0;
  const pnlPct = bot && bot.baseEquity > 0 ? (pnl / bot.baseEquity) * 100 : 0;

  return (
    <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="flex items-center gap-2">
        <span style={{ background: AI_GRADIENT }} className="flex size-8 items-center justify-center rounded-full text-white">
          <Robot size={18} weight="fill" />
        </span>
        <span className="text-[16px] font-semibold">AI 托管</span>
        {bot && (
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", bot.status === "running" ? "bg-up/15 text-up" : "bg-[#f59e0b]/15 text-[#b45309]")}>
            {bot.status === "running" ? "运行中" : "已暂停"}
          </span>
        )}
        {bot && (
          <button type="button" aria-label="托管设置" onClick={() => setSheet("setup")} className="ml-auto text-muted-foreground">
            <GearSix size={20} />
          </button>
        )}
      </div>

      {q.isLoading && <div className="mt-3 h-12 animate-pulse rounded-xl bg-muted/60" />}
      {q.isError && <p className="mt-3 text-[13px] text-muted-foreground">托管状态读不到：{(q.error as Error).message}</p>}

      {st && !bot && (
        <>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">不用盯盘：AI 每 15 分钟看一次行情，按你定的杠杆、仓位和止损自动开平仓，亏到你设的比例自动全平停下。服务器拿到的交易钥匙只能交易、不能提现，钱一直在你自己的账户里。</p>
          <PrimaryButton className="mt-3" disabled={!st.enabled} onClick={open}>
            {st.enabled ? "开启 AI 托管" : "托管暂未开放"}
          </PrimaryButton>
        </>
      )}

      {bot && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Stat k="托管盈亏" v={`${pnl >= 0 ? "+" : ""}${usd(pnl)}`} sub={`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`} tone={pnl >= 0 ? "up" : "down"} />
            <Stat k="币种" v={bot.cfg.coins.join(" ")} sub={`${bot.cfg.maxLeverage}x · ${bot.cfg.maxPct}%`} />
            <Stat k={bot.status === "running" ? "下次分析" : "亏损止停"} v={bot.status === "running" ? <Countdown at={bot.nextRunAt} /> : `${bot.cfg.maxLossPct}%`} sub={providerOf(bot.ai.provider).name} />
          </div>
          {bot.status === "paused" && bot.reason && <p className="mt-3 rounded-xl bg-[#f59e0b]/10 px-3 py-2 text-[12px] leading-5 text-[#b45309]">暂停原因：{bot.reason}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {bot.status === "running" ? (
              <GhostButton disabled={!!busy} onClick={() => void act("pause", () => pauseBot(main()), "已暂停，持仓保持不动")}>
                <Pause size={16} weight="fill" /> {busy === "pause" ? "暂停中…" : "暂停"}
              </GhostButton>
            ) : (
              <GhostButton disabled={!!busy} onClick={() => void act("resume", () => resumeBot(main()), "已继续托管")}>
                <Play size={16} weight="fill" /> {busy === "resume" ? "继续中…" : "继续"}
              </GhostButton>
            )}
            <GhostButton disabled={!!busy} onClick={() => setSheet("stop")}>
              <Stop size={16} weight="fill" /> 停止
            </GhostButton>
          </div>
        </>
      )}

      {st && st.events.length > 0 && <Events events={st.events} />}

      <BottomSheet open={sheet === "setup"} onClose={() => setSheet(null)}>
        {sheet === "setup" && aiCfg && (
          <SetupSheet
            list={list}
            initial={bot?.cfg ?? DEFAULT_BOT}
            aiCfg={aiCfg}
            editing={!!bot}
            sameAi={!!bot && bot.ai.provider === aiCfg.provider && (bot.ai.model || "") === (aiCfg.model || "")}
            busy={busy === "setup"}
            onSubmit={(cfg, newAi) => void act("setup", () => (bot ? updateBot(main(), cfg, newAi ? aiCfg : undefined) : startBot(main(), cfg, aiCfg)), bot ? "设置已保存" : "AI 托管已开启，马上开始第一次分析")}
          />
        )}
        {sheet === "setup" && !aiCfg && <p className="py-6 text-center text-[14px] text-muted-foreground">先在右上角「AI 设置」填好大模型 key</p>}
      </BottomSheet>
      <BottomSheet open={sheet === "stop"} onClose={() => setSheet(null)}>
        {sheet === "stop" && bot && <StopSheet coins={bot.cfg.coins} busy={busy === "stop"} onCancel={() => setSheet(null)} onStop={(closeAll) => void act("stop", () => stopBot(main(), closeAll), "托管已停止，交易钥匙已作废")} />}
      </BottomSheet>
    </section>
  );
}

function Stat({ k, v, sub, tone }: { k: string; v: React.ReactNode; sub: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-xl bg-muted/60 px-2 py-2">
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className={cn("mt-0.5 truncate font-mono text-[14px] font-semibold", tone === "up" && "text-up", tone === "down" && "text-down")}>{v}</div>
      <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((at - now) / 1000));
  return <>{s <= 0 ? "分析中…" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</>;
}

const KIND: Record<string, { label: string; cls: string }> = {
  open: { label: "开仓", cls: "bg-up/15 text-up" },
  close: { label: "平仓", cls: "bg-foreground/10 text-foreground" },
  skip: { label: "跳过", cls: "bg-muted text-muted-foreground" },
  error: { label: "出错", cls: "bg-down/15 text-down" },
  pause: { label: "暂停", cls: "bg-[#f59e0b]/15 text-[#b45309]" },
  start: { label: "开启", cls: "bg-up/15 text-up" },
  resume: { label: "继续", cls: "bg-up/15 text-up" },
  stop: { label: "停止", cls: "bg-muted text-muted-foreground" },
  config: { label: "设置", cls: "bg-muted text-muted-foreground" },
};
const ACTION: Record<string, string> = { long: "看多", short: "看空", close: "平仓", hold: "持有", wait: "观望" };

function Events({ events }: { events: BotEvent[] }) {
  const [all, setAll] = useState(false);
  const rows = all ? events : events.slice(0, 8);
  return (
    <div className="mt-4">
      <div className="mb-1 text-[13px] font-semibold">托管记录</div>
      <ul className="divide-y divide-border/50">
        {rows.map((e) => {
          const k = e.kind === "decision" ? { label: `AI ${ACTION[String(e.data?.action)] ?? ""}`, cls: "bg-[#7c3aed]/10 text-[#6d28d9]" } : (KIND[e.kind] ?? { label: e.kind, cls: "bg-muted" });
          return (
            <li key={e.id} className="py-2 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">{new Date(e.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                {e.coin && <span className="font-semibold">{e.coin}</span>}
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", k.cls)}>{k.label}</span>
                {e.kind === "decision" && <span className="ml-auto text-muted-foreground">信心 {String(e.data?.confidence ?? "")} · @ {px(Number(e.data?.price ?? 0))}</span>}
              </div>
              <div className="mt-0.5 leading-5 text-foreground/80">{e.text}</div>
            </li>
          );
        })}
      </ul>
      {events.length > 8 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-[12px] text-muted-foreground underline underline-offset-4">
          {all ? "收起" : `查看全部 ${events.length} 条`}
        </button>
      )}
    </div>
  );
}

function SetupSheet({ list, initial, aiCfg, editing, sameAi, busy, onSubmit }: { list: HlAsset[]; initial: BotCfg; aiCfg: AiConfig; editing: boolean; sameAi: boolean; busy: boolean; onSubmit: (cfg: BotCfg, newAi: boolean) => void }) {
  const [coins, setCoins] = useState(initial.coins);
  const [maxLeverage, setMaxLeverage] = useState(initial.maxLeverage);
  const [maxPct, setMaxPct] = useState(initial.maxPct);
  const [minConfidence, setMinConfidence] = useState(initial.minConfidence);
  const [maxLossPct, setMaxLossPct] = useState(initial.maxLossPct);
  const [ok, setOk] = useState(editing);
  const [useNewAi, setUseNewAi] = useState(false);
  const choices = useMemo(() => list.filter((a) => a.oi >= MIN_OI_USD).sort((a, b) => b.oi - a.oi).slice(0, 15).map((a) => a.name), [list]);
  const toggle = (c: string) => setCoins((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : cs.length >= MAX_COINS ? cs : [...cs, c]));
  return (
    <>
      <div className="text-center text-[17px] font-semibold">{editing ? "托管设置" : "开启 AI 托管"}</div>
      <div className="mt-4 text-[13px] font-medium text-muted-foreground">托管哪些币（最多 {MAX_COINS} 个，只列流动性好的）</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {choices.map((c) => (
          <button key={c} type="button" onClick={() => toggle(c)} className={cn("h-8 rounded-full px-3 text-[13px] font-semibold ring-1", coins.includes(c) ? "bg-foreground text-background ring-foreground" : "ring-border")}>
            {c}
          </button>
        ))}
      </div>
      <Slider label="杠杆最多" value={maxLeverage} min={1} max={10} unit="倍" onChange={setMaxLeverage} />
      <Slider label="每笔最多用可用余额的" value={maxPct} min={5} max={50} step={5} unit="%" onChange={setMaxPct} />
      <Slider label="AI 信心低于多少不开仓" value={minConfidence} min={50} max={90} step={5} unit="" onChange={setMinConfidence} />
      <Slider label="总共亏到多少自动全平并停下" value={maxLossPct} min={10} max={50} step={5} unit="%" onChange={setMaxLossPct} />
      <div className="mt-4 rounded-xl bg-muted/60 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
        用你的 {providerOf(aiCfg.provider).name}（{aiCfg.model || providerOf(aiCfg.provider).model}）分析，每个币每 15 分钟一次，费用记在你的大模型账户上（DeepSeek 一个币一天大约几毛钱）。
        {editing && !sameAi && (
          <label className="mt-1 flex items-center gap-2 text-foreground">
            <input type="checkbox" checked={useNewAi} onChange={(e) => setUseNewAi(e.target.checked)} className="size-4" />
            换成钱包里现在的 AI 设置
          </label>
        )}
      </div>
      {!editing && (
        <label className="mt-3 flex items-start gap-2 text-[13px] leading-5">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="mt-0.5 size-4" />
          我明白 AI 会不经我确认自动下单，可能亏损；主钱包会签一次名，授权服务器上的交易钥匙（只能交易、不能提现，180 天有效）。
        </label>
      )}
      <PrimaryButton className="mt-4" disabled={!coins.length || !ok || busy} onClick={() => onSubmit({ coins, maxLeverage, maxPct, minConfidence, maxLossPct }, useNewAi)}>
        {busy ? <Spinner /> : editing ? "保存" : "签名并开启"}
      </PrimaryButton>
    </>
  );
}

function StopSheet({ coins, busy, onCancel, onStop }: { coins: string[]; busy: boolean; onCancel: () => void; onStop: (closeAll: boolean) => void }) {
  const [closeAll, setCloseAll] = useState(true);
  return (
    <>
      <div className="text-center text-[17px] font-semibold">停止 AI 托管？</div>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">服务器会删掉交易钥匙，钱包再签一次名让它在 Hyperliquid 上作废。以后想用可以重新开启。</p>
      <label className="mt-3 flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={closeAll} onChange={(e) => setCloseAll(e.target.checked)} className="size-4" />
        同时市价平掉 {coins.join("、")} 的仓位
      </label>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <GhostButton onClick={onCancel}>取消</GhostButton>
        <PrimaryButton tone="down" disabled={busy} onClick={() => onStop(closeAll)}>
          {busy ? "停止中…" : "停止托管"}
        </PrimaryButton>
      </div>
    </>
  );
}
