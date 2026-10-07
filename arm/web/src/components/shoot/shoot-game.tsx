"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Coins, Loader2, RotateCcw, Share2, Volume2, VolumeX, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { boatRunEnd, boatRunStart, useBoatInfo, type BoatRunEnd } from "@/lib/boat";
import { useBoatAccount } from "@/components/boat/use-boat-account";
import { cn } from "@/lib/utils";
import { ShootEngine, type Phase } from "./engine";
import { FX_KEYS, FX_NAMES, fxFromQuery, type Fx } from "./fx";

const BEST_KEY = "arm-shoot-best";
const FX_HOTKEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];
const hasWebGL = () => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } };
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };
const fmtRate = (r: number) => (r >= 1 ? "1" : r.toFixed(2));
const practiceText = (why: "runs" | "ip" | "balance" | null, zh: boolean) =>
  why === "balance" ? (zh ? "余额不足 10，这局是练习，不扣不奖" : "Balance under 10: practice run, no fee, no reward")
  : why === "ip" ? (zh ? "这个网络今天的计分局数满了，这局是练习" : "This network used up today's ranked runs: practice run")
  : (zh ? "今天 10 局计分用完了（几款游戏合计），这局是练习，明天 0 点再来" : "Today's 10 ranked runs (all games) are used: practice run. Back at 00:00 UTC+8");

export default function ShootGame() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ShootEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [result, setResult] = useState({ score: 0, best: 0, record: false });
  const [best, setBest] = useState(readBest);
  const [failed] = useState(() => !hasWebGL());
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("arm-shoot-muted") === "1"; } catch { return false; } });
  const [fx, setFxState] = useState<Fx | null>(() => fxFromQuery(new URLSearchParams(window.location.search).get("fx")));
  const acct = useBoatAccount();
  const info = useBoatInfo();
  const live = !!info.data?.enabled;
  const [starting, setStarting] = useState(false);
  const [ranked, setRanked] = useState(false);
  const [payout, setPayout] = useState<BoatRunEnd | null>(null);
  const runRef = useRef<{ id: string; token: string } | null>(null);
  const perBoat = info.data?.rules.shootPointsPerBoat ?? 10;

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
        const r = await boatRunStart(acct.token, "shoot");
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
    if (!host || failed) return;
    let engine: ShootEngine;
    try {
      engine = new ShootEngine(host, {
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
      }, fx);
    } catch {
      return;
    }
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
    // fx is only the starting state; later toggles go straight to the engine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  useEffect(() => { if (engineRef.current) engineRef.current.zh = zh; }, [zh, phase]);

  const toggleFx = (k: (typeof FX_KEYS)[number]) => {
    setFxState((cur) => {
      if (!cur) return cur;
      const next = { ...cur, [k]: !cur[k] };
      engineRef.current?.setFx(k, next[k]);
      return next;
    });
  };
  const setAllFx = (on: boolean) => {
    setFxState((cur) => {
      if (!cur) return cur;
      for (const k of FX_KEYS) engineRef.current?.setFx(k, on);
      return Object.fromEntries(FX_KEYS.map((k) => [k, on])) as Fx;
    });
  };
  useEffect(() => {
    if (!fx) return;
    const onKey = (e: KeyboardEvent) => {
      const i = FX_HOTKEYS.indexOf(e.key);
      if (i >= 0) toggleFx(FX_KEYS[i]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fx !== null]); // eslint-disable-line react-hooks/exhaustive-deps

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
      ? `我在霓虹打击里打了 ${result.score.toLocaleString()} 分 💥 你能打多少？`
      : `I scored ${result.score.toLocaleString()} in Neon Strike 💥 Can you beat it?`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${location.origin}/shoot`)}`, "_blank", "noopener");
  };

  return (
    <div className="fixed inset-0 z-[100] select-none overflow-hidden bg-[#05060d] text-white">
      <div ref={hostRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <div className="flex flex-col items-start gap-2">
          <Link href="/games" className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-white/10 backdrop-blur" aria-label={zh ? "返回" : "Back"}>
            <ArrowLeft className="size-5" />
          </Link>
          {fx && (
            <div className="pointer-events-auto flex max-w-[15rem] flex-wrap gap-1">
              {FX_KEYS.map((k, i) => (
                <button key={k} type="button" onClick={() => toggleFx(k)} title={FX_HOTKEYS[i]}
                  className={cn("rounded border px-1.5 py-0.5 text-[11px] font-semibold", fx[k] ? "border-emerald-400/70 bg-emerald-500/20 text-emerald-200" : "border-white/20 bg-black/30 text-white/50")}>
                  {fx[k] ? "✓" : ""}{FX_NAMES[k][zh ? 0 : 1]}
                </button>
              ))}
              <button type="button" onClick={() => setAllFx(true)} className="rounded border border-white/20 px-1.5 py-0.5 text-[11px]">{zh ? "全开" : "All on"}</button>
              <button type="button" onClick={() => setAllFx(false)} className="rounded border border-white/20 px-1.5 py-0.5 text-[11px]">{zh ? "全关" : "All off"}</button>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold backdrop-blur">
            {zh ? "最佳" : "Best"} {best.toLocaleString()}
          </div>
          <button
            type="button"
            onClick={toggleMute}
            className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-white/10 backdrop-blur"
            aria-label={muted ? (zh ? "打开声音" : "Unmute") : (zh ? "静音" : "Mute")}
          >
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </button>
        </div>
      </div>

      {phase === "ready" && !failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-end gap-4 bg-gradient-to-t from-black/70 via-black/10 to-transparent pb-16 text-center">
          <h1 className="text-4xl font-black italic tracking-tight text-cyan-200 drop-shadow-[0_0_18px_rgba(56,232,255,0.7)] sm:text-6xl">{zh ? "霓虹打击" : "Neon Strike"}</h1>
          <p className="max-w-sm px-4 text-base font-medium opacity-95 drop-shadow">
            {zh ? "飞船自动开火，你只管走位。15 种卡通水果混在霓虹怪里，一枪切成两半、果汁溅满屏。打爆精英、大水果、金苹果会掉武器胶囊：散弹、激光、追踪导弹、穿透速射、全屏炸弹。连击叠倍率最高 ×3，连击 40 进入狂热。碰到敌人或子弹就结束，越往后越难。" : "Your ship fires on its own: just move. 15 kinds of cartoon fruit fly in with the neon shapes, split in half and splash juice across the screen. Elites, big fruit and golden apples drop weapon capsules: spread, laser, homing missiles, pierce, screen bomb. Chain kills for up to ×3; combo 40 starts a fever. One touch ends it, and it keeps getting harder."}
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
                  ? `和快艇、赛车共用 $BOAT：一局门票 ${entry}，每 ${perBoat} 分得 ${fmtRate(info.data?.rate ?? 1)} 枚，单局最多 ${info.data?.rules.maxReward ?? 300}。`
                  : `Same $BOAT as the boat and the car: ${entry} per run, ${fmtRate(info.data?.rate ?? 1)} BOAT per ${perBoat} points, up to ${info.data?.rules.maxReward ?? 300} a run.`}
                {" "}<Link href="/games" className="underline">{zh ? "游戏探索" : "Games"}</Link>
              </p>
            </div>
          )}
          <Button size="lg" className="h-14 rounded-full px-10 text-lg font-bold" onClick={start} disabled={starting}>
            {starting && <Loader2 className="mr-1 size-5 animate-spin" />}{goLabel}
          </Button>
          <p className="max-w-md px-4 text-xs opacity-80">{zh ? "手机：按住屏幕任意位置拖动 · 电脑：鼠标移动，或 ← → ↑ ↓ / WASD · 飞过胶囊即拾取 · 连击 15 双管、30 三管" : "Phone: drag anywhere · Desktop: move the mouse, or arrows / WASD · Fly into a capsule to grab it · Combo 15 twin, 30 triple shots"}</p>
        </div>
      )}

      {phase === "over" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55 text-center backdrop-blur-[2px]">
          {result.record && <div className="rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-black">{zh ? "新纪录！" : "New best!"}</div>}
          <div className="text-lg font-semibold opacity-90">{zh ? "本局得分" : "Score"}</div>
          <div className="font-mono text-7xl font-black italic tabular-nums leading-none">{result.score.toLocaleString()}</div>
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
