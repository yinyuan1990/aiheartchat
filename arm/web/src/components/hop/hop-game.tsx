"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Coins, Loader2, RotateCcw, Share2, Volume2, VolumeX, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { boatRunEnd, boatRunStart, useBoatInfo, type BoatRunEnd } from "@/lib/boat";
import { useBoatAccount } from "@/components/boat/use-boat-account";
import { HopEngine, type Phase } from "./engine";

const BEST_KEY = "arm-hop-best";
const SOURCE = "https://codepen.io/HunorMarton/pen/JwWLJo";
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const fmtPerLane = (n: number) => String(Math.round(n * 100) / 100);
const practiceText = (why: "runs" | "ip" | "balance" | null, zh: boolean) =>
  why === "balance" ? (zh ? "余额不足 10，这局是练习，不扣不奖" : "Balance under 10: practice run, no fee, no reward")
  : why === "ip" ? (zh ? "这个网络今天的计分局数满了，这局是练习" : "This network used up today's ranked runs: practice run")
  : (zh ? "今天 10 局计分用完了（几款游戏合计），这局是练习，明天 0 点再来" : "Today's 10 ranked runs (all games) are used: practice run. Back at 00:00 UTC+8");

export default function HopGame() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<HopEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [danger, setDanger] = useState(0);
  const [result, setResult] = useState({ score: 0, best: 0, record: false });
  const [best, setBest] = useState(readBest);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("arm-hop-muted") === "1"; } catch { return false; } });
  const acct = useBoatAccount();
  const info = useBoatInfo();
  const live = !!info.data?.enabled;
  const [starting, setStarting] = useState(false);
  const [ranked, setRanked] = useState(false);
  const [payout, setPayout] = useState<BoatRunEnd | null>(null);
  const runRef = useRef<{ id: string; token: string } | null>(null);
  const perStep = info.data?.rules.hopBoatPerStep ?? 2;

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
        const r = await boatRunStart(acct.token, "hop");
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
  const finishRun = async (s: number) => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    try {
      setPayout(await boatRunEnd(run.token, run.id, s));
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
    const engine = new HopEngine(host, {
      onPhase: (p, s) => {
        setPhase(p);
        if (p !== "over") return;
        void endRef.current(s);
        const prev = readBest();
        const record = s > prev;
        if (record) try { localStorage.setItem(BEST_KEY, String(s)); } catch { /* private mode */ }
        setBest(Math.max(prev, s));
        setResult({ score: s, best: Math.max(prev, s), record });
      },
      onRequestStart: () => void startRef.current(),
      onScore: setScore,
      onDanger: setDanger,
    });
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
  }, []);

  useEffect(() => { if (engineRef.current) engineRef.current.zh = zh; }, [zh, phase]);

  const start = () => void requestStart();
  const me = acct.me;
  const balance = me ? me.bonus + me.cash : 0;
  const entry = info.data?.rules.entry ?? 10;
  const maxReward = info.data?.rules.maxReward ?? 300;
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
      ? `我的小鸡过了 ${result.score} 条马路 🐔 你能走多远？`
      : `My chicken crossed ${result.score} lanes 🐔 How far can you get?`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${location.origin}/hop`)}`, "_blank", "noopener");
  };
  const credit = (
    <p className="pointer-events-auto max-w-sm px-4 text-[11px] opacity-75">
      {zh ? "改编自 Hunor Márton Borbély 的开源作品 " : "Adapted from Hunor Márton Borbély's open-source "}
      <a href={SOURCE} target="_blank" rel="noreferrer" className="underline">Crossy Road with three.js</a>
      {zh ? "（MIT 授权）· " : " (MIT) · "}
      <a href="/hop/License-crossy-road.txt" target="_blank" rel="noreferrer" className="underline">{zh ? "授权" : "License"}</a>
    </p>
  );

  return (
    <div className="fixed inset-0 z-[100] select-none overflow-hidden bg-[#2f6b3a] text-white">
      <div ref={hostRef} className="absolute inset-0" />
      {phase === "playing" && danger > 0 && (
        <div className="pointer-events-none absolute inset-0" style={{ boxShadow: `inset 0 -${40 + danger * 120}px ${60 + danger * 120}px -20px rgba(220,38,38,${0.25 + danger * 0.5})` }} />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <Link href="/games" className="pointer-events-auto flex size-10 items-center justify-center rounded-full backdrop-blur" style={{ background: "rgba(0,0,0,0.3)" }} aria-label={zh ? "返回" : "Back"}>
          <ArrowLeft className="size-5" />
        </Link>
        {phase === "playing" && <div className="font-mono text-5xl font-black tabular-nums" style={{ textShadow: "0 3px 0 rgba(0,0,0,0.35)" }}>{score}</div>}
        <div className="flex items-center gap-2">
          {phase !== "playing" && (
            <div className="rounded-full px-3 py-1.5 text-sm font-semibold backdrop-blur" style={{ background: "rgba(0,0,0,0.3)" }}>
              {zh ? "最佳" : "Best"} {best}
            </div>
          )}
          <button type="button" onClick={toggleMute} className="pointer-events-auto flex size-10 items-center justify-center rounded-full backdrop-blur" style={{ background: "rgba(0,0,0,0.3)" }} aria-label={muted ? (zh ? "打开声音" : "Unmute") : (zh ? "静音" : "Mute")}>
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </button>
        </div>
      </div>

      {phase === "playing" && danger > 0.35 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 text-center text-lg font-black" style={{ color: "#fecaca", textShadow: "0 2px 0 rgba(0,0,0,0.5)" }}>
          🦅 {zh ? "老鹰来了，快往前跳！" : "The eagle is coming, hop forward!"}
        </div>
      )}

      {phase === "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-end gap-4 pb-10 text-center" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0.15) 55%, transparent)" }}>
          <div className="mb-auto mt-16">
            <div className="text-6xl">🐔</div>
            <h1 className="mt-2 text-4xl font-black tracking-tight" style={{ textShadow: "0 4px 0 rgba(0,0,0,0.35)" }}>{zh ? "小鸡过马路" : "Chicken Cross"}</h1>
          </div>
          <p className="max-w-sm px-4 text-base font-medium opacity-95">
            {zh
              ? "点一下屏幕往前跳一格，左右滑横着走、往下滑后退。躲开小车和大卡车，树挡路要绕开。越往前车越快越多；停太久落在后面，老鹰会把你叼走。"
              : "Tap to hop forward, swipe left or right to sidestep, swipe down to step back. Dodge the cars and trucks, go round the trees. Traffic gets faster and thicker; fall behind and the eagle takes you."}
          </p>
          {live && (
            <div className="pointer-events-auto w-full max-w-xs rounded-2xl px-4 py-3 text-sm backdrop-blur" style={{ background: "rgba(0,0,0,0.5)" }}>
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
                  ? `和其它游戏共用 $BOAT：一局门票 ${entry}，往前过 1 条得 ${fmtPerLane((info.data?.rate ?? 1) * perStep)} 枚，单局最多 ${maxReward}。`
                  : `Same $BOAT as the other games: ${entry} per run, ${fmtPerLane((info.data?.rate ?? 1) * perStep)} BOAT per lane, up to ${maxReward} a run.`}
                {" "}<Link href="/games" className="underline">{zh ? "游戏探索" : "Games"}</Link>
              </p>
            </div>
          )}
          <Button size="lg" className="h-14 rounded-full px-10 text-lg font-bold" onClick={start} disabled={starting}>
            {starting && <Loader2 className="mr-1 size-5 animate-spin" />}{goLabel}
          </Button>
          <p className="max-w-md px-4 text-xs opacity-80">{zh ? "电脑：方向键 / WASD，空格往前" : "Desktop: arrow keys / WASD, Space hops forward"}</p>
          {credit}
        </div>
      )}

      {phase === "over" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center backdrop-blur-[2px]" style={{ background: "rgba(0,0,0,0.55)" }}>
          {result.record && <div className="rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-black">{zh ? "新纪录！" : "New best!"}</div>}
          <div className="text-lg font-semibold opacity-90">{zh ? "过了几条" : "Lanes crossed"}</div>
          <div className="font-mono text-7xl font-black tabular-nums leading-none">{result.score}</div>
          <div className="text-sm opacity-80">{zh ? "最佳" : "Best"} {result.best}</div>
          {ranked && (
            <div className="mt-2 rounded-full bg-amber-400 px-4 py-1.5 text-base font-bold text-black">
              {payout ? `+${payout.reward.toLocaleString()} BOAT` : <Loader2 className="size-4 animate-spin" />}
            </div>
          )}
          {payout && me && <div className="text-xs opacity-80">{zh ? "余额" : "Balance"} {(me.bonus + me.cash).toLocaleString()} BOAT · <Link href="/games" className="underline">{zh ? "提现 / 交易" : "Withdraw / trade"}</Link></div>}
          {live && !ranked && !me && <button type="button" className="text-sm underline opacity-90" onClick={() => void acct.login()}>{zh ? `这局没计分。连钱包送 100 BOAT，每过 1 条得 ${perStep} 枚` : `Not ranked. Connect a wallet for 100 BOAT, ${perStep} per lane`}</button>}
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
