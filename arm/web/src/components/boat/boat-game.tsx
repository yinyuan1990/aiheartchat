"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Coins, Loader2, RotateCcw, Share2, Volume2, VolumeX, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { boatRunEnd, boatRunStart, useBoatInfo, type BoatRunEnd } from "@/lib/boat";
import { BoatEngine, type Phase } from "./engine";
import { useBoatAccount } from "./use-boat-account";

// v2: distances are game metres (world ÷ 4) since the $BOAT rules; the old key held world units
const BEST_KEY = "arm-boat-best-v2";
const hasWebGL = () => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } };
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const fmtRate = (r: number) => (r >= 1 ? "1" : r.toFixed(2));
const practiceText = (why: "runs" | "ip" | "balance" | null, zh: boolean) =>
  why === "balance" ? (zh ? "余额不足 10，这局是练习，不扣不奖" : "Balance under 10: practice run, no fee, no reward")
  : why === "ip" ? (zh ? "这个网络今天的计分局数满了，这局是练习" : "This network used up today's ranked runs: practice run")
  : (zh ? "今天 10 局计分用完了，这局是练习，明天 0 点再来" : "Today's 10 ranked runs are used: practice run. Back at 00:00 UTC+8");

export default function BoatGame() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const hostRef = useRef<HTMLDivElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<BoatEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [result, setResult] = useState({ m: 0, best: 0, record: false });
  const [best, setBest] = useState(readBest);
  const [failed] = useState(() => !hasWebGL());
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("arm-boat-muted") === "1"; } catch { return false; } });
  const acct = useBoatAccount();
  const info = useBoatInfo();
  const live = !!info.data?.enabled;
  const [starting, setStarting] = useState(false);
  const [ranked, setRanked] = useState(false);
  const [payout, setPayout] = useState<BoatRunEnd | null>(null);
  const runRef = useRef<{ id: string; token: string } | null>(null);

  // the engine is built once; its start / end callbacks go through refs so they always see the current session
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
        const r = await boatRunStart(acct.token);
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
  const finishRun = async (m: number) => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    try {
      setPayout(await boatRunEnd(run.token, run.id, m));
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
    if (!host || failed) return;
    let engine: BoatEngine;
    try {
      engine = new BoatEngine(host, {
        onPhase: (p, m) => {
          setPhase(p);
          if (p !== "over") return;
          void endRef.current(m);
          const prev = readBest();
          const record = m > prev;
          if (record) try { localStorage.setItem(BEST_KEY, String(m)); } catch { /* private mode */ }
          setBest(Math.max(prev, m));
          setResult({ m, best: Math.max(prev, m), record });
        },
        onDistance: (m, kmh) => {
          if (distRef.current) distRef.current.textContent = m.toLocaleString();
          if (speedRef.current) speedRef.current.textContent = String(kmh);
        },
        onRequestStart: () => void startRef.current(),
      });
    } catch {
      return;
    }
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
  }, [failed]);

  const start = () => void requestStart();
  const me = acct.me;
  const balance = me ? me.bonus + me.cash : 0;
  const entry = info.data?.rules.entry ?? 10;
  const goLabel = !live || !me ? (zh ? "开船" : "Go")
    : me.runsToday >= me.runsPerDay || balance < entry ? (zh ? "练习（不计奖励）" : "Practice (no reward)")
    : (zh ? `开船 · 门票 ${entry}` : `Go · ${entry} BOAT`);
  const toggleMute = () => {
    const a = engineRef.current?.audio;
    if (!a) return;
    a.unlock();
    a.setMuted(!muted);
    setMuted(!muted);
  };
  const share = () => {
    const text = zh
      ? `我开快艇跑了 ${result.m.toLocaleString()} 米 🚤 你能跑多远？`
      : `I drove my speedboat ${result.m.toLocaleString()} m 🚤 How far can you go?`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${location.origin}/boat`)}`, "_blank", "noopener");
  };

  return (
    <div className="fixed inset-0 z-[100] select-none overflow-hidden bg-[#cdeef5] text-white">
      <div ref={hostRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <Link href="/games" className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-black/25 backdrop-blur" aria-label={zh ? "返回" : "Back"}>
          <ArrowLeft className="size-5" />
        </Link>
        {phase === "playing" && (
          <div className="text-center drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]">
            <div className="font-mono text-5xl font-black tabular-nums leading-none"><span ref={distRef}>0</span><span className="ml-1 text-2xl">m</span></div>
            <div className="mt-1 text-sm font-semibold opacity-90"><span ref={speedRef}>0</span> km/h</div>
          </div>
        )}
        <div className="flex flex-col items-end gap-2">
          <div className="rounded-full bg-black/25 px-3 py-1.5 text-sm font-semibold backdrop-blur">
            {zh ? "最佳" : "Best"} {best.toLocaleString()} m
          </div>
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

      {phase === "ready" && !failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-end gap-4 bg-gradient-to-t from-black/45 via-black/10 to-transparent pb-20 text-center">
          <h1 className="text-4xl font-black tracking-tight drop-shadow-lg sm:text-5xl">{zh ? "快艇冲冲冲" : "Speedboat Dash"}</h1>
          <p className="max-w-xs text-base font-medium opacity-95 drop-shadow">{zh ? "左右躲、往上跳，越过礁石和浮标。撞上就结束，跑多远算多远。" : "Dodge or jump the rocks and buoys. One hit and it's over. Every metre counts."}</p>
          {live && (
            <div className="pointer-events-auto w-full max-w-xs rounded-2xl bg-black/35 px-4 py-3 text-sm backdrop-blur">
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
                  ? `一局门票 ${entry}，跑 1 米得 ${fmtRate(info.data?.rate ?? 1)} 枚，单局最多 ${info.data?.rules.maxReward ?? 300}。`
                  : `${entry} per run, ${fmtRate(info.data?.rate ?? 1)} BOAT per metre, up to ${info.data?.rules.maxReward ?? 300} a run.`}
                {" "}<Link href="/games" className="underline">{zh ? "游戏探索" : "Games"}</Link>
              </p>
            </div>
          )}
          <Button size="lg" className="h-14 rounded-full px-10 text-lg font-bold" onClick={start} disabled={starting}>
            {starting && <Loader2 className="mr-1 size-5 animate-spin" />}{goLabel}
          </Button>
          <p className="text-xs opacity-80">{zh ? "手机：点左 / 右半边或左右滑换道，上滑跳 · 电脑：← → 换道，↑ 或空格跳 · 后面有炮击，看到红圈快躲" : "Phone: tap left / right or swipe to steer, swipe up to jump · Desktop: ← → steer, ↑ or Space jump · Later there's artillery: red ring = get out of that lane"}</p>
        </div>
      )}

      {phase === "over" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/45 text-center backdrop-blur-[2px]">
          {result.record && <div className="rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-black">{zh ? "新纪录！" : "New best!"}</div>}
          <div className="text-lg font-semibold opacity-90">{zh ? "你跑了" : "You went"}</div>
          <div className="font-mono text-7xl font-black tabular-nums leading-none">{result.m.toLocaleString()}<span className="ml-1 text-3xl">m</span></div>
          <div className="text-sm opacity-80">{zh ? "最佳" : "Best"} {result.best.toLocaleString()} m</div>
          {ranked && (
            <div className="mt-2 rounded-full bg-amber-400/90 px-4 py-1.5 text-base font-bold text-black">
              {payout ? `+${payout.reward.toLocaleString()} BOAT` : <Loader2 className="size-4 animate-spin" />}
            </div>
          )}
          {payout && me && <div className="text-xs opacity-80">{zh ? "余额" : "Balance"} {(me.bonus + me.cash).toLocaleString()} BOAT · <Link href="/games" className="underline">{zh ? "提现 / 交易" : "Withdraw / trade"}</Link></div>}
          {live && !ranked && !me && <button type="button" className="text-sm underline opacity-90" onClick={() => void acct.login()}>{zh ? "这局没计分。连钱包送 100 BOAT，跑 1 米得 1 枚" : "Not ranked. Connect a wallet for 100 BOAT and earn per metre"}</button>}
          <div className="mt-4 flex gap-3">
            <Button size="lg" className="h-12 rounded-full px-7 font-bold" onClick={start}><RotateCcw className="mr-1 size-4" />{zh ? "再来一局" : "Again"}</Button>
            <Button size="lg" variant="secondary" className="h-12 rounded-full px-7 font-bold" onClick={share}><Share2 className="mr-1 size-4" />{zh ? "晒到 X" : "Share"}</Button>
          </div>
          <Link href="/games" className="mt-2 flex items-center gap-1 text-sm font-semibold opacity-90 hover:opacity-100">
            <ArrowLeft className="size-4" />{zh ? "返回游戏探索" : "Back to Games"}
          </Link>
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900 p-6 text-center text-sm">
          {zh ? "你的浏览器不支持 WebGL，换个浏览器试试。" : "Your browser doesn't support WebGL."}
        </div>
      )}
    </div>
  );
}
