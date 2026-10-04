"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, Coins, Loader2, RotateCcw, Share2, Volume2, VolumeX, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { boatRunEnd, boatRunStart, useBoatInfo, type BoatRunEnd } from "@/lib/boat";
import { useBoatAccount } from "@/components/boat/use-boat-account";
import { RaceEngine, type Phase } from "./engine";
import { PLAYER_CARS, type PlayerCar } from "./models";

const BEST_KEY = "arm-race-best";
const hasWebGL = () => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } };
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const fmtRate = (r: number) => (r >= 1 ? "1" : r.toFixed(2));
const CAR_NAMES: Record<PlayerCar, [string, string]> = {
  race: ["红色方程式", "Red Formula"],
  "race-future": ["蓝色未来", "Blue Future"],
  "sedan-sports": ["街头跑车", "Street Coupe"],
  "hatchback-sports": ["小钢炮", "Hot Hatch"],
};
const practiceText = (why: "runs" | "ip" | "balance" | null, zh: boolean) =>
  why === "balance" ? (zh ? "余额不足 10，这局是练习，不扣不奖" : "Balance under 10: practice run, no fee, no reward")
  : why === "ip" ? (zh ? "这个网络今天的计分局数满了，这局是练习" : "This network used up today's ranked runs: practice run")
  : (zh ? "今天 10 局计分用完了（几款游戏合计），这局是练习，明天 0 点再来" : "Today's 10 ranked runs (all games) are used: practice run. Back at 00:00 UTC+8");

export default function RaceGame() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const hostRef = useRef<HTMLDivElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<RaceEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [result, setResult] = useState({ m: 0, best: 0, record: false, near: 0 });
  const [best, setBest] = useState(readBest);
  const [failed] = useState(() => !hasWebGL());
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("arm-race-muted") === "1"; } catch { return false; } });
  const [car, setCar] = useState<PlayerCar>("race");
  const [near, setNear] = useState<{ n: number; key: number } | null>(null);
  const nearCount = useRef(0);
  const acct = useBoatAccount();
  const info = useBoatInfo();
  const live = !!info.data?.enabled;
  const [starting, setStarting] = useState(false);
  const [ranked, setRanked] = useState(false);
  const [payout, setPayout] = useState<BoatRunEnd | null>(null);
  const runRef = useRef<{ id: string; token: string } | null>(null);

  const requestStart = async () => {
    const engine = engineRef.current;
    if (!engine || starting) return;
    engine.audio.unlock();
    setPayout(null);
    runRef.current = null;
    setRanked(false);
    nearCount.current = 0;
    if (live && acct.token) {
      setStarting(true);
      try {
        const r = await boatRunStart(acct.token, "race");
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
    let engine: RaceEngine;
    try {
      engine = new RaceEngine(host, {
        onPhase: (p, m) => {
          setPhase(p);
          if (p !== "over") return;
          void endRef.current(m);
          const prev = readBest();
          const record = m > prev;
          if (record) try { localStorage.setItem(BEST_KEY, String(m)); } catch { /* private mode */ }
          setBest(Math.max(prev, m));
          setResult({ m, best: Math.max(prev, m), record, near: nearCount.current });
        },
        onDistance: (m, kmh) => {
          if (distRef.current) distRef.current.textContent = m.toLocaleString();
          if (speedRef.current) speedRef.current.textContent = String(kmh);
        },
        onRequestStart: () => void startRef.current(),
        onNearMiss: (n) => {
          nearCount.current = n;
          setNear({ n, key: Date.now() });
        },
      });
    } catch {
      return;
    }
    engineRef.current = engine;
    setCar(engine.carChoice);
    return () => { engine.dispose(); engineRef.current = null; };
  }, [failed]);

  const start = () => void requestStart();
  const cycleCar = (d: number) => {
    const i = (PLAYER_CARS.indexOf(car) + d + PLAYER_CARS.length) % PLAYER_CARS.length;
    const next = PLAYER_CARS[i];
    setCar(next);
    engineRef.current?.setCar(next);
  };
  const me = acct.me;
  const balance = me ? me.bonus + me.cash : 0;
  const entry = info.data?.rules.entry ?? 10;
  const goLabel = !live || !me ? (zh ? "出发" : "Go")
    : me.runsToday >= me.runsPerDay || balance < entry ? (zh ? "练习（不计奖励）" : "Practice (no reward)")
    : (zh ? `出发 · 门票 ${entry}` : `Go · ${entry} BOAT`);
  const toggleMute = () => {
    const a = engineRef.current?.audio;
    if (!a) return;
    a.unlock();
    a.setMuted(!muted);
    setMuted(!muted);
  };
  const share = () => {
    const text = zh
      ? `我在跨海大桥上飙了 ${result.m.toLocaleString()} 米 🏎️ 你能开多远？`
      : `I raced ${result.m.toLocaleString()} m across the sea bridge 🏎️ How far can you go?`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${location.origin}/race`)}`, "_blank", "noopener");
  };

  return (
    <div className="fixed inset-0 z-[100] select-none overflow-hidden bg-[#2b2452] text-white">
      <div ref={hostRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <Link href="/games" className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-black/30 backdrop-blur" aria-label={zh ? "返回" : "Back"}>
          <ArrowLeft className="size-5" />
        </Link>
        {phase === "playing" && (
          <div className="text-center drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]">
            <div className="font-mono text-5xl font-black italic tabular-nums leading-none"><span ref={distRef}>0</span><span className="ml-1 text-2xl">m</span></div>
            <div className="mt-1 text-sm font-semibold opacity-90"><span ref={speedRef}>0</span> km/h</div>
          </div>
        )}
        <div className="flex flex-col items-end gap-2">
          <div className="rounded-full bg-black/30 px-3 py-1.5 text-sm font-semibold backdrop-blur">
            {zh ? "最佳" : "Best"} {best.toLocaleString()} m
          </div>
          <button
            type="button"
            onClick={toggleMute}
            className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-black/30 backdrop-blur"
            aria-label={muted ? (zh ? "打开声音" : "Unmute") : (zh ? "静音" : "Mute")}
          >
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </button>
        </div>
      </div>

      {phase === "playing" && near && (
        <div key={near.key} className="race-pop pointer-events-none absolute inset-x-0 top-[28%] z-10 text-center" onAnimationEnd={() => setNear(null)}>
          <span className="font-black italic tracking-wide text-amber-300 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" style={{ fontSize: near.n > 2 ? 34 : 28 }}>
            {zh ? "擦肩而过" : "Close call"}{near.n > 1 ? ` ×${near.n}` : ""}
          </span>
        </div>
      )}

      {phase === "ready" && !failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-end gap-4 bg-gradient-to-t from-black/60 via-black/10 to-transparent pb-16 text-center">
          <h1 className="text-4xl font-black italic tracking-tight drop-shadow-lg sm:text-6xl">{zh ? "极速跨海" : "Bridge Rush"}</h1>
          <p className="max-w-sm text-base font-medium opacity-95 drop-shadow">
            {zh ? "左右变道躲车，往上弹跳越过路障。锥桶会减速，撞车就结束。冲上跳台能飞过一切。" : "Change lanes around traffic, hop the barriers. Cones slow you down, a crash ends it. Hit a ramp to fly over everything."}
          </p>
          <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-black/35 px-2 py-1.5 backdrop-blur">
            <button type="button" className="flex size-8 items-center justify-center rounded-full hover:bg-white/10" onClick={() => cycleCar(-1)} aria-label={zh ? "上一辆" : "Previous car"}><ChevronLeft className="size-5" /></button>
            <span className="min-w-28 text-sm font-semibold">{CAR_NAMES[car][zh ? 0 : 1]}</span>
            <button type="button" className="flex size-8 items-center justify-center rounded-full hover:bg-white/10" onClick={() => cycleCar(1)} aria-label={zh ? "下一辆" : "Next car"}><ChevronRight className="size-5" /></button>
          </div>
          {live && (
            <div className="pointer-events-auto w-full max-w-xs rounded-2xl bg-black/40 px-4 py-3 text-sm backdrop-blur">
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
                  ? `和快艇共用 $BOAT：一局门票 ${entry}，开 1 米得 ${fmtRate(info.data?.rate ?? 1)} 枚，单局最多 ${info.data?.rules.maxReward ?? 300}。`
                  : `Same $BOAT as the speedboat: ${entry} per run, ${fmtRate(info.data?.rate ?? 1)} BOAT per metre, up to ${info.data?.rules.maxReward ?? 300} a run.`}
                {" "}<Link href="/games" className="underline">{zh ? "游戏探索" : "Games"}</Link>
              </p>
            </div>
          )}
          <Button size="lg" className="h-14 rounded-full px-10 text-lg font-bold" onClick={start} disabled={starting}>
            {starting && <Loader2 className="mr-1 size-5 animate-spin" />}{goLabel}
          </Button>
          <p className="max-w-md px-4 text-xs opacity-80">{zh ? "手机：点左 / 右半边或左右滑变道，上滑弹跳 · 电脑：← → 变道，↑ 或空格弹跳 · 后面会有逆行车，看到红色箭头快换道" : "Phone: tap left / right or swipe to steer, swipe up to hop · Desktop: ← → steer, ↑ or Space hop · Later, wrong-way trucks: red arrows = leave that lane"}</p>
        </div>
      )}

      {phase === "over" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50 text-center backdrop-blur-[2px]">
          {result.record && <div className="rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-black">{zh ? "新纪录！" : "New best!"}</div>}
          <div className="text-lg font-semibold opacity-90">{zh ? "你开了" : "You drove"}</div>
          <div className="font-mono text-7xl font-black italic tabular-nums leading-none">{result.m.toLocaleString()}<span className="ml-1 text-3xl">m</span></div>
          <div className="text-sm opacity-80">
            {zh ? "最佳" : "Best"} {result.best.toLocaleString()} m{result.near > 0 && <> · {zh ? `擦肩 ${result.near} 次` : `${result.near} close calls`}</>}
          </div>
          {ranked && (
            <div className="mt-2 rounded-full bg-amber-400/90 px-4 py-1.5 text-base font-bold text-black">
              {payout ? `+${payout.reward.toLocaleString()} BOAT` : <Loader2 className="size-4 animate-spin" />}
            </div>
          )}
          {payout && me && <div className="text-xs opacity-80">{zh ? "余额" : "Balance"} {(me.bonus + me.cash).toLocaleString()} BOAT · <Link href="/games" className="underline">{zh ? "提现 / 交易" : "Withdraw / trade"}</Link></div>}
          {live && !ranked && !me && <button type="button" className="text-sm underline opacity-90" onClick={() => void acct.login()}>{zh ? "这局没计分。连钱包送 100 BOAT，开 1 米得 1 枚" : "Not ranked. Connect a wallet for 100 BOAT and earn per metre"}</button>}
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
