"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Coins, Loader2, RotateCcw, Share2, Volume2, VolumeX, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { boatRunEnd, boatRunStart, useBoatInfo, type BoatRunEnd } from "@/lib/boat";
import { useBoatAccount } from "@/components/boat/use-boat-account";
import { TowerEngine, type Phase } from "./engine";

const BEST_KEY = "arm-tower-best";
const SOURCE = "https://github.com/iamkun/tower_game";
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const fmtRate = (r: number) => (r >= 1 ? "1" : r.toFixed(2));
const practiceText = (why: "runs" | "ip" | "balance" | null, zh: boolean) =>
  why === "balance" ? (zh ? "余额不足 10，这局是练习，不扣不奖" : "Balance under 10: practice run, no fee, no reward")
  : why === "ip" ? (zh ? "这个网络今天的计分局数满了，这局是练习" : "This network used up today's ranked runs: practice run")
  : (zh ? "今天 10 局计分用完了（几款游戏合计），这局是练习，明天 0 点再来" : "Today's 10 ranked runs (all games) are used: practice run. Back at 00:00 UTC+8");

export default function TowerGame() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TowerEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [result, setResult] = useState({ score: 0, best: 0, record: false });
  const [best, setBest] = useState(readBest);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("arm-tower-muted") === "1"; } catch { return false; } });
  const acct = useBoatAccount();
  const info = useBoatInfo();
  const live = !!info.data?.enabled;
  const [starting, setStarting] = useState(false);
  const [ranked, setRanked] = useState(false);
  const [payout, setPayout] = useState<BoatRunEnd | null>(null);
  const runRef = useRef<{ id: string; token: string } | null>(null);
  const perBoat = info.data?.rules.towerPointsPerBoat ?? 10;

  const requestStart = async () => {
    const engine = engineRef.current;
    if (!engine || starting) return;
    engine.audio.unlock();
    setPayout(null);
    runRef.current = null;
    setRanked(false);
    if (live && acct.token) {
      setStarting(true);
      try {
        const r = await boatRunStart(acct.token, "tower");
        runRef.current = { id: r.id, token: acct.token };
        setRanked(r.ranked);
        if (!r.ranked) toast(practiceText(r.practiceReason, zh));
        void acct.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
      }
    }
    engine.start();
  };
  const finishRun = async (score: number) => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    try {
      setPayout(await boatRunEnd(run.token, run.id, score));
      void acct.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const startRef = useRef(requestStart);
  const endRef = useRef(finishRun);
  useEffect(() => { startRef.current = requestStart; endRef.current = finishRun; });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new TowerEngine(host, {
      onPhase: (p, score) => {
        setPhase(p);
        if (p !== "over") return;
        void endRef.current(score);
        const prev = readBest();
        const record = score > prev;
        if (record) try { localStorage.setItem(BEST_KEY, String(score)); } catch { /* private mode */ }
        setBest(Math.max(prev, score));
        setResult({ score, best: Math.max(prev, score), record });
      },
      onRequestStart: () => void startRef.current(),
    });
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
  }, []);

  useEffect(() => { if (engineRef.current) engineRef.current.zh = zh; }, [zh, phase]);

  const start = () => void requestStart();
  const me = acct.me;
  const balance = me ? me.bonus + me.cash : 0;
  const entry = info.data?.rules.entry ?? 10;
  const goLabel = !live || !me ? (zh ? "开始" : "Start")
    : me.runsToday >= me.runsPerDay || balance < entry ? (zh ? "练习（不计奖励）" : "Practice (no reward)")
    : (zh ? `开始 · 门票 ${entry}` : `Start · ${entry} BOAT`);
  const toggleMute = () => {
    const a = engineRef.current?.audio;
    if (!a) return;
    a.unlock();
    a.setMuted(!muted);
    setMuted(!muted);
  };
  const share = () => {
    const text = zh
      ? `我在来啊盖楼啊里盖了 ${result.score.toLocaleString()} 分 🏗️ 你能盖多高？`
      : `I scored ${result.score.toLocaleString()} in Tower Building 🏗️ How high can you go?`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${location.origin}/tower`)}`, "_blank", "noopener");
  };
  const credit = (
    <p className="pointer-events-auto max-w-sm px-4 text-[11px] opacity-75">
      {zh ? "改编自开源游戏 " : "Adapted from the open-source "}
      <a href={SOURCE} target="_blank" rel="noreferrer" className="underline">iamkun/tower_game</a>
      {zh ? "（MIT 授权，玩法、图片和音效来自原作）· " : " (MIT; gameplay, art and sound from the original) · "}
      <a href="/tower/License-tower_game.txt" target="_blank" rel="noreferrer" className="underline">{zh ? "授权" : "License"}</a>
    </p>
  );

  return (
    <div className="fixed inset-0 z-[100] select-none overflow-hidden bg-[#f95240] text-white">
      <style>{"@keyframes tower-swing{0%{transform:rotate(5deg)}100%{transform:rotate(-5deg)}}"}</style>
      <div ref={hostRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <Link href="/games" className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-black/25 backdrop-blur" aria-label={zh ? "返回" : "Back"}>
          <ArrowLeft className="size-5" />
        </Link>
        <div className="flex items-center gap-2">
          {phase !== "playing" && (
            <div className="rounded-full bg-black/25 px-3 py-1.5 text-sm font-semibold backdrop-blur">
              {zh ? "最佳" : "Best"} {best.toLocaleString()}
            </div>
          )}
          <button
            type="button"
            onClick={toggleMute}
            className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-black/25 backdrop-blur"
            aria-label={muted ? (zh ? "打开声音" : "Unmute") : (zh ? "静音" : "Mute")}
          >
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </button>
        </div>
      </div>

      {phase === "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-end gap-4 pb-10 text-center" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0.1) 55%, transparent)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tower/main-index-title.png" alt={zh ? "来啊盖楼啊" : "Tower Building"} className="mb-auto mt-14 w-[min(60vw,15rem)]" style={{ animation: "tower-swing 2s ease-in-out infinite alternate", transformOrigin: "top center" }} />
          {!zh && <h1 className="text-3xl font-black tracking-tight drop-shadow">Tower Building</h1>}
          <p className="max-w-sm px-4 text-base font-medium opacity-95 drop-shadow">
            {zh ? "吊钩带着楼块左右摆，点一下屏幕放下去。叠稳一层 25 分，正中「完美」再加分，连续完美越加越多。歪太多会翻下去，掉 3 块就结束，越往上摆得越猛。" : "The crane swings a floor back and forth: tap to drop it. 25 points a floor, more for a dead-centre Perfect, and more again for Perfects in a row. Lean too far and it topples; three falls and you're out. The higher you go, the wilder the swing."}
          </p>
          {live && (
            <div className="pointer-events-auto w-full max-w-xs rounded-2xl bg-black/50 px-4 py-3 text-sm backdrop-blur">
              {me ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5"><Coins className="size-4 text-amber-300" /><b className="font-mono">{balance.toLocaleString()}</b> BOAT</span>
                  <span className="opacity-80">{zh ? "今日计分" : "Ranked today"} {me.runsToday}/{me.runsPerDay}</span>
                </div>
              ) : (
                <button type="button" className="flex w-full items-center justify-center gap-2 font-semibold" onClick={() => void acct.login()} disabled={acct.busy}>
                  {acct.busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                  {!acct.connected ? (zh ? "连钱包，送 100 BOAT" : "Connect wallet, get 100 BOAT") : (zh ? "签名登录，送 100 BOAT" : "Sign in, get 100 BOAT")}
                </button>
              )}
              <p className="mt-1.5 text-xs opacity-75">
                {zh
                  ? `和快艇、赛车、射击共用 $BOAT：一局门票 ${entry}，每 ${perBoat} 分得 ${fmtRate(info.data?.rate ?? 1)} 枚，单局最多 ${info.data?.rules.maxReward ?? 300}。`
                  : `Same $BOAT as the other games: ${entry} per run, ${fmtRate(info.data?.rate ?? 1)} BOAT per ${perBoat} points, up to ${info.data?.rules.maxReward ?? 300} a run.`}
                {" "}<Link href="/games" className="underline">{zh ? "游戏探索" : "Games"}</Link>
              </p>
            </div>
          )}
          <Button size="lg" className="h-14 rounded-full px-10 text-lg font-bold" onClick={start} disabled={starting}>
            {starting && <Loader2 className="mr-1 size-5 animate-spin" />}{goLabel}
          </Button>
          <p className="max-w-md px-4 text-xs opacity-80">{zh ? "手机：点屏幕任意位置 · 电脑：点鼠标，或按空格 / ↓" : "Phone: tap anywhere · Desktop: click, or press Space / ↓"}</p>
          {credit}
        </div>
      )}

      {phase === "over" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55 text-center backdrop-blur-[2px]">
          {result.record && <div className="rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-black">{zh ? "新纪录！" : "New best!"}</div>}
          <div className="text-lg font-semibold opacity-90">{zh ? "本局得分" : "Score"}</div>
          <div className="font-mono text-7xl font-black tabular-nums leading-none">{result.score.toLocaleString()}</div>
          <div className="text-sm opacity-80">{zh ? "最佳" : "Best"} {result.best.toLocaleString()}</div>
          {ranked && (
            <div className="mt-2 rounded-full bg-amber-400/90 px-4 py-1.5 text-base font-bold text-black">
              {payout ? `+${payout.reward.toLocaleString()} BOAT` : <Loader2 className="size-4 animate-spin" />}
            </div>
          )}
          {payout && me && <div className="text-xs opacity-80">{zh ? "余额" : "Balance"} {(me.bonus + me.cash).toLocaleString()} BOAT · <Link href="/games" className="underline">{zh ? "提现 / 交易" : "Withdraw / trade"}</Link></div>}
          {live && !ranked && !me && <button type="button" className="text-sm underline opacity-90" onClick={() => void acct.login()}>{zh ? `这局没计分。连钱包送 100 BOAT，每 ${perBoat} 分得 1 枚` : `Not ranked. Connect a wallet for 100 BOAT, 1 per ${perBoat} points`}</button>}
          <div className="mt-4 flex gap-3">
            <Button size="lg" className="h-12 rounded-full px-7 font-bold" onClick={start}><RotateCcw className="mr-1 size-4" />{zh ? "再来一局" : "Again"}</Button>
            <Button size="lg" variant="secondary" className="h-12 rounded-full px-7 font-bold" onClick={share}><Share2 className="mr-1 size-4" />{zh ? "晒到 X" : "Share"}</Button>
          </div>
          <Link href="/games" className="mt-2 flex items-center gap-1 text-sm font-semibold opacity-90 hover:opacity-100">
            <ArrowLeft className="size-4" />{zh ? "返回游戏探索" : "Back to Games"}
          </Link>
          {credit}
        </div>
      )}
    </div>
  );
}
