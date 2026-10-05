"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocalAccount } from "viem";
import { GearSix, Pause, Play, Robot, Stop } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { HlAsset } from "@/lib/wallet/hl";
import { providerName, providerOf, type AiConfig } from "@/lib/wallet/ai-trade";
import { t } from "@/lib/wallet/i18n";
import { DEFAULT_BOT, MAX_COINS, MIN_OI_USD, botState, pauseBot, resumeBot, startBot, stopBot, updateBot, type BotCfg, type BotEvent, type BotState } from "@/lib/wallet/aibot";
import { BottomSheet, GhostButton, PrimaryButton } from "./ui";
import { AI_GRADIENT, Slider, Spinner, px, sUsd } from "./perp-parts";

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
    if (!funded) return toast.error(t("cw.aibot.needFunds"));
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
        <span className="text-[16px] font-semibold">{t("cw.aibot.title")}</span>
        {bot && (
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", bot.status === "running" ? "bg-up/15 text-up" : "bg-[#f59e0b]/15 text-[#b45309]")}>
            {t(bot.status === "running" ? "cw.aibot.running" : "cw.aibot.paused")}
          </span>
        )}
        {bot && (
          <button type="button" aria-label={t("cw.aibot.settings")} onClick={() => setSheet("setup")} className="ml-auto text-muted-foreground">
            <GearSix size={20} />
          </button>
        )}
      </div>

      {q.isLoading && <div className="mt-3 h-12 animate-pulse rounded-xl bg-muted/60" />}
      {q.isError && <p className="mt-3 text-[13px] text-muted-foreground">{t("cw.aibot.stateError", { msg: (q.error as Error).message })}</p>}

      {st && !bot && (
        <>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{t("cw.aibot.intro")}</p>
          <PrimaryButton className="mt-3" disabled={!st.enabled} onClick={open}>
            {t(st.enabled ? "cw.aibot.enable" : "cw.aibot.unavailable")}
          </PrimaryButton>
        </>
      )}

      {bot && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Stat k={t("cw.aibot.pnl")} v={sUsd(pnl)} sub={`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`} tone={pnl >= 0 ? "up" : "down"} />
            <Stat k={t("cw.aibot.coins")} v={bot.cfg.coins.join(" ")} sub={`${bot.cfg.maxLeverage}x · ${bot.cfg.maxPct}%`} />
            <Stat k={t(bot.status === "running" ? "cw.aibot.nextRun" : "cw.aibot.lossStop")} v={bot.status === "running" ? <Countdown at={bot.nextRunAt} /> : `${bot.cfg.maxLossPct}%`} sub={providerName(providerOf(bot.ai.provider))} />
          </div>
          {bot.status === "paused" && bot.reason && <p className="mt-3 rounded-xl bg-[#f59e0b]/10 px-3 py-2 text-[12px] leading-5 text-[#b45309]">{t("cw.aibot.pauseReason", { reason: bot.reason })}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {bot.status === "running" ? (
              <GhostButton disabled={!!busy} onClick={() => void act("pause", () => pauseBot(main()), t("cw.aibot.pausedToast"))}>
                <Pause size={16} weight="fill" /> {busy === "pause" ? t("cw.aibot.pausing") : t("cw.aibot.pause")}
              </GhostButton>
            ) : (
              <GhostButton disabled={!!busy} onClick={() => void act("resume", () => resumeBot(main()), t("cw.aibot.resumedToast"))}>
                <Play size={16} weight="fill" /> {busy === "resume" ? t("cw.aibot.resuming") : t("cw.aibot.resume")}
              </GhostButton>
            )}
            <GhostButton disabled={!!busy} onClick={() => setSheet("stop")}>
              <Stop size={16} weight="fill" /> {t("cw.aibot.stop")}
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
            onSubmit={(cfg, newAi) => void act("setup", () => (bot ? updateBot(main(), cfg, newAi ? aiCfg : undefined) : startBot(main(), cfg, aiCfg)), t(bot ? "cw.aibot.saved" : "cw.aibot.started"))}
          />
        )}
        {sheet === "setup" && !aiCfg && <p className="py-6 text-center text-[14px] text-muted-foreground">{t("cw.aibot.needAi")}</p>}
      </BottomSheet>
      <BottomSheet open={sheet === "stop"} onClose={() => setSheet(null)}>
        {sheet === "stop" && bot && <StopSheet coins={bot.cfg.coins} busy={busy === "stop"} onCancel={() => setSheet(null)} onStop={(closeAll) => void act("stop", () => stopBot(main(), closeAll), t("cw.aibot.stopped"))} />}
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
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((at - now) / 1000));
  return <>{s <= 0 ? t("cw.aibot.analyzing") : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</>;
}

const KIND: Record<string, { label: string; cls: string }> = {
  open: { label: "cw.aibot.evOpen", cls: "bg-up/15 text-up" },
  close: { label: "cw.aibot.evClose", cls: "bg-foreground/10 text-foreground" },
  skip: { label: "cw.aibot.evSkip", cls: "bg-muted text-muted-foreground" },
  error: { label: "cw.aibot.evError", cls: "bg-down/15 text-down" },
  pause: { label: "cw.aibot.pause", cls: "bg-[#f59e0b]/15 text-[#b45309]" },
  start: { label: "cw.aibot.evStart", cls: "bg-up/15 text-up" },
  resume: { label: "cw.aibot.resume", cls: "bg-up/15 text-up" },
  stop: { label: "cw.aibot.stop", cls: "bg-muted text-muted-foreground" },
  config: { label: "cw.aibot.evConfig", cls: "bg-muted text-muted-foreground" },
};
const ACTION: Record<string, string> = { long: "cw.aibot.actLong", short: "cw.aibot.actShort", close: "cw.perp.actClose", hold: "cw.perp.actHold", wait: "cw.perp.actWait" };

function Events({ events }: { events: BotEvent[] }) {
  const [all, setAll] = useState(false);
  const rows = all ? events : events.slice(0, 8);
  return (
    <div className="mt-4">
      <div className="mb-1 text-[13px] font-semibold">{t("cw.aibot.log")}</div>
      <ul className="divide-y divide-border/50">
        {rows.map((e) => {
          const action = ACTION[String(e.data?.action)];
          const k = e.kind === "decision" ? { label: `AI ${action ? t(action) : ""}`, cls: "bg-[#7c3aed]/10 text-[#6d28d9]" } : KIND[e.kind] ? { label: t(KIND[e.kind].label), cls: KIND[e.kind].cls } : { label: e.kind, cls: "bg-muted" };
          return (
            <li key={e.id} className="py-2 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">{new Date(e.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                {e.coin && <span className="font-semibold">{e.coin}</span>}
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", k.cls)}>{k.label}</span>
                {e.kind === "decision" && <span className="ml-auto text-muted-foreground">{t("cw.perp.confidenceN", { n: String(e.data?.confidence ?? "") })} · @ {px(Number(e.data?.price ?? 0))}</span>}
              </div>
              <div className="mt-0.5 leading-5 text-foreground/80">{e.text}</div>
            </li>
          );
        })}
      </ul>
      {events.length > 8 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-[12px] text-muted-foreground underline underline-offset-4">
          {all ? t("cw.aibot.collapse") : t("cw.aibot.viewAll", { n: events.length })}
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
      <div className="text-center text-[17px] font-semibold">{t(editing ? "cw.aibot.settings" : "cw.aibot.enable")}</div>
      <div className="mt-4 text-[13px] font-medium text-muted-foreground">{t("cw.aibot.pickCoins", { n: MAX_COINS })}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {choices.map((c) => (
          <button key={c} type="button" onClick={() => toggle(c)} className={cn("h-8 rounded-full px-3 text-[13px] font-semibold ring-1", coins.includes(c) ? "bg-foreground text-background ring-foreground" : "ring-border")}>
            {c}
          </button>
        ))}
      </div>
      <Slider label={t("cw.aibot.maxLev")} value={maxLeverage} min={1} max={10} unit={t("cw.perp.xUnit")} onChange={setMaxLeverage} />
      <Slider label={t("cw.aibot.maxPct")} value={maxPct} min={5} max={50} step={5} unit="%" onChange={setMaxPct} />
      <Slider label={t("cw.aibot.minConf")} value={minConfidence} min={50} max={90} step={5} unit="" onChange={setMinConfidence} />
      <Slider label={t("cw.aibot.maxLoss")} value={maxLossPct} min={10} max={50} step={5} unit="%" onChange={setMaxLossPct} />
      <div className="mt-4 rounded-xl bg-muted/60 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
        {t("cw.aibot.aiNote", { name: providerName(providerOf(aiCfg.provider)), model: aiCfg.model || providerOf(aiCfg.provider).model })}
        {editing && !sameAi && (
          <label className="mt-1 flex items-center gap-2 text-foreground">
            <input type="checkbox" checked={useNewAi} onChange={(e) => setUseNewAi(e.target.checked)} className="size-4" />
            {t("cw.aibot.useNewAi")}
          </label>
        )}
      </div>
      {!editing && (
        <label className="mt-3 flex items-start gap-2 text-[13px] leading-5">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="mt-0.5 size-4" />
          {t("cw.aibot.consent")}
        </label>
      )}
      <PrimaryButton className="mt-4" disabled={!coins.length || !ok || busy} onClick={() => onSubmit({ coins, maxLeverage, maxPct, minConfidence, maxLossPct }, useNewAi)}>
        {busy ? <Spinner /> : editing ? t("common.save") : t("cw.aibot.signStart")}
      </PrimaryButton>
    </>
  );
}

function StopSheet({ coins, busy, onCancel, onStop }: { coins: string[]; busy: boolean; onCancel: () => void; onStop: (closeAll: boolean) => void }) {
  const [closeAll, setCloseAll] = useState(true);
  return (
    <>
      <div className="text-center text-[17px] font-semibold">{t("cw.aibot.stopQ")}</div>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">{t("cw.aibot.stopInfo")}</p>
      <label className="mt-3 flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={closeAll} onChange={(e) => setCloseAll(e.target.checked)} className="size-4" />
        {t("cw.aibot.closeAll", { coins: coins.join(t("cw.aibot.listSep")) })}
      </label>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <GhostButton onClick={onCancel}>{t("common.cancel")}</GhostButton>
        <PrimaryButton tone="down" disabled={busy} onClick={() => onStop(closeAll)}>
          {busy ? t("cw.aibot.stopping") : t("cw.aibot.stopBot")}
        </PrimaryButton>
      </div>
    </>
  );
}
