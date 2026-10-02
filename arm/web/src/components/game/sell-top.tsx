"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Copy, Loader2, Mountain, RotateCcw, Trophy, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useSignMessage } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/components/providers";
import { errMsg } from "@/components/shared";
import { COLOR } from "@/components/tools/launch-replay";
import {
  gameSell, gameSession, gameSignMessage, gameStart, gameTick, useGameBoard, useGamePlay, useGameToday,
  type GameEvent, type GameResult, type GameSession,
} from "@/lib/api";
import { refLink } from "@/lib/referral";
import { shortAddr } from "@/lib/format";
import type { DictKey } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { pct, personaOf, shareGrid, strip, times } from "./format";

/** The share strip drawn as blocks: emoji squares render inconsistently across fonts (tweets still use them). */
function Squares({ r, big }: { r: Pick<GameResult, "up" | "capture">; big?: boolean }) {
  const s = strip(r);
  return (
    <span className={cn("inline-flex", big ? "gap-1" : "gap-0.5")}>
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={cn(big ? "size-5 rounded" : "size-2.5 rounded-[2px]", i < s.filled ? (s.up ? "bg-up" : "bg-down") : "bg-muted-foreground/25")} />
      ))}
    </span>
  );
}

const POLL_MS = 400;

function clock(sec: number, zh: boolean) {
  if (sec < 60) return zh ? `${Math.floor(sec)} 秒` : `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
const hms = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const money = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "+";
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(1)}K` : `${s}$${a.toFixed(0)}`;
};

const storeKey = (day: string) => `arm-game:${day}`;
type Stored = { id: string; result?: GameResult };
const readStored = (day: string): Stored | null => {
  try { return JSON.parse(localStorage.getItem(storeKey(day)) ?? "null"); } catch { return null; }
};
const writeStored = (day: string, v: Stored) => { try { localStorage.setItem(storeKey(day), JSON.stringify(v)); } catch { /* private mode */ } };

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

type Pt = { t: number; x: number; side?: 1 | -1; usdc?: number; role?: GameEvent["role"] };

/** sqrt time axis over the hour, log price axis in multiples of the entry; the range only grows, eased, so it never hints ahead. */
function Chart({ pts, now, T, entryT, sold, peak, live }: { pts: Pt[]; now: number; T: number; entryT: number; sold?: { t: number; x: number }; peak?: { t: number; x: number }; live: boolean }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const range = useRef<{ lo: number; hi: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = size.w, H = size.h, padL = 36, padB = 18, padT = 10, padR = 8;
    const fg = getComputedStyle(c).color;
    const shown = pts.filter((p) => p.t <= now);
    const xs = shown.map((p) => p.x);
    const want = { lo: Math.log(Math.min(0.6, ...xs) * 0.85), hi: Math.log(Math.max(1.8, ...xs) * 1.2) };
    const r = range.current ?? want;
    r.lo += (Math.min(r.lo, want.lo) - r.lo) * (live ? 0.25 : 1);
    r.hi += (Math.max(r.hi, want.hi) - r.hi) * (live ? 0.25 : 1);
    range.current = r;
    const X = (sec: number) => padL + Math.sqrt(Math.max(0, Math.min(sec, T)) / T) * (W - padL - padR);
    const Y = (m: number) => padT + (1 - (Math.log(m) - r.lo) / (r.hi - r.lo)) * (H - padT - padB);
    g.clearRect(0, 0, W, H);

    g.font = "10px ui-monospace, monospace";
    g.fillStyle = g.strokeStyle = fg;
    for (const m of [0.25, 0.5, 1, 2, 3, 5, 10, 20, 50, 100]) {
      const y = Y(m);
      if (y < padT || y > H - padB) continue;
      g.globalAlpha = m === 1 ? 0.5 : 0.12;
      g.setLineDash(m === 1 ? [4, 4] : []);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
      g.globalAlpha = 0.55;
      g.fillText(`${m}x`, 2, y + 3);
    }
    g.setLineDash([]);
    g.globalAlpha = 0.6;
    g.fillText(t("game.you"), padL + 4, Y(1) - 4);
    for (const s of [60, 300, 900, 3600]) {
      if (s > T) continue;
      const x = X(s);
      g.globalAlpha = 0.1;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - padB); g.stroke();
      g.globalAlpha = 0.55;
      g.fillText(s < 3600 ? (zh ? `${s / 60}分` : `${s / 60}m`) : zh ? "1小时" : "1h", x - 10, H - 4);
    }
    // entry
    g.globalAlpha = 0.25;
    g.beginPath(); g.moveTo(X(entryT), padT); g.lineTo(X(entryT), H - padB); g.stroke();

    g.lineWidth = 1.6;
    for (const pass of [0, 1]) {
      g.globalAlpha = pass === 0 ? 0.35 : 0.95;
      g.beginPath();
      let on = false;
      for (const p of shown) {
        if ((pass === 0) !== (p.t <= entryT)) continue;
        if (on) g.lineTo(X(p.t), Y(p.x)); else { g.moveTo(X(p.t), Y(p.x)); on = true; }
      }
      if (pass === 1 && on && live) g.lineTo(X(now), Y(shown.at(-1)!.x));
      g.stroke();
    }
    for (const p of shown) {
      if (!p.role || p.usdc === undefined) continue;
      const rr = Math.max(1.8, Math.min(12, 1.4 + Math.sqrt(p.usdc) * 0.6));
      g.globalAlpha = p.t <= entryT ? 0.35 : 0.7;
      g.fillStyle = g.strokeStyle = COLOR[p.role];
      g.beginPath(); g.arc(X(p.t), Y(p.x), rr, 0, Math.PI * 2);
      if (p.side === 1) g.fill(); else { g.lineWidth = 1.2; g.stroke(); }
    }
    g.globalAlpha = 1;
    if (live && shown.length) {
      const last = shown.at(-1)!;
      const y = Y(last.x), x = X(now);
      g.fillStyle = last.x >= 1 ? "#3ddc97" : "#ff5c5c";
      g.shadowColor = g.fillStyle; g.shadowBlur = 12;
      g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
    }
    const mark = (p: { t: number; x: number }, color: string, label: string, up: boolean) => {
      const x = X(p.t), y = Y(p.x);
      g.fillStyle = g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
      g.font = "bold 11px ui-sans-serif, system-ui";
      const w = g.measureText(label).width;
      g.fillText(label, Math.min(W - padR - w, Math.max(padL, x - w / 2)), up ? y - 11 : y + 19);
    };
    if (peak) mark(peak, "#eab308", `⛰ ${times(peak.x)}`, true);
    if (sold) mark(sold, sold.x >= 1 ? "#3ddc97" : "#ff5c5c", `💰 ${times(sold.x)}`, false);
  }, [pts, now, T, entryT, sold, peak, live, size, t, zh]);

  return (
    <div ref={boxRef} className="relative h-64 w-full text-foreground sm:h-80">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </div>
  );
}

/** One live round: the server hands out trades up to its game clock; we draw them on our own synced clock. */
function Round({ s, onDone }: { s: GameSession; onDone: (r: GameResult) => void }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const [offset] = useState(() => s.serverNow - Date.now());
  const [events, setEvents] = useState<GameEvent[]>(s.pre);
  const evRef = useRef(s.pre);
  const [now, setNow] = useState(s.entry.t);
  const [wait, setWait] = useState(() => Math.max(0, s.startAt - s.serverNow));
  const selling = useRef(false);
  const [busy, setBusy] = useState(false);

  const sell = useCallback(async () => {
    if (selling.current) return;
    selling.current = true;
    setBusy(true);
    try {
      onDone(await gameSell(s.id));
    } catch (e) {
      selling.current = false;
      setBusy(false);
      toast.error(errMsg(e));
    }
  }, [onDone, s.id]);

  useEffect(() => {
    let raf = 0;
    const step = () => {
      const ms = Date.now() + offset - s.startAt;
      setWait(Math.max(0, -ms));
      const u = Math.min(1, Math.max(0, ms) / s.durMs);
      setNow(s.entry.t + (s.T - s.entry.t) * u * u);
      if (u >= 1) { void sell(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [offset, s, sell]);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const r = await gameTick(s.id, evRef.current.length);
        if (r.from === evRef.current.length && r.events.length) {
          evRef.current = [...evRef.current, ...r.events];
          setEvents(evRef.current);
        }
      } catch { /* next poll */ }
      if (!stop) setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { stop = true; };
  }, [s.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); void sell(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sell]);

  const pts = useMemo(() => events.filter((e) => e.x !== null).map((e) => ({ t: e.t, x: e.x!, side: e.side, usdc: e.usdc, role: e.role })), [events]);
  const cur = useMemo(() => {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= now && pts[i].t >= s.entry.t) return pts[i].x;
    return 1;
  }, [pts, now, s.entry.t]);
  const progress = Math.sqrt(Math.max(0, now - s.entry.t) / Math.max(1, s.T - s.entry.t));

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="font-mono text-xs text-muted-foreground tabular-nums">{t("game.clock").replace("{t}", clock(now, zh))}</div>
          <div className={cn("font-mono text-4xl font-black tabular-nums", cur >= 1 ? "text-up" : "text-down")}>{times(cur)}</div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {t("game.title").replace("{n}", String(s.n))}
          {!s.counted && <div className="text-[10px]">{t("game.result.practice")}</div>}
        </div>
      </div>
      <div className="relative">
        <Chart pts={pts} now={now} T={s.T} entryT={s.entry.t} live />
        {wait > 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
            <span key={Math.ceil(wait / 1000)} className="fade-up font-mono text-7xl font-black">{Math.ceil(wait / 1000)}</span>
          </div>
        )}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} /></div>
      <Button size="xl" variant="glow" className="h-16 w-full text-2xl font-black tracking-widest" disabled={busy || wait > 0} onClick={() => void sell()}>
        {busy ? <Loader2 className="size-6 animate-spin" /> : t("game.sell")}
      </Button>
      <p className="text-center text-[11px] text-muted-foreground">{t("game.sellHint")}</p>
    </div>
  );
}

function Result({ r, onAgain }: { r: GameResult; onAgain: () => void }) {
  const { t, locale, address } = useApp();
  const zh = locale === "zh";
  const persona = personaOf(r);
  const grid = shareGrid(r);
  const share = address ? refLink(address, `/game/r/${r.id}`) : `${window.location.origin}/game/r/${r.id}`;
  const tweet = t("game.tweet")
    .replace("{n}", String(r.n)).replace("{persona}", t(`game.persona.${persona}` as DictKey))
    .replace("{beat}", r.beat !== null && r.others >= 5 ? t("game.tweet.beat").replace("{p}", pct(r.beat)) : "")
    .replace("{grid}", grid).replace("{rank}", String(r.entry.rank));
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(share)}`;
  const rv = r.reveal;
  const coin = rv?.coin;
  const pts = useMemo(() => (rv?.path ?? []).map(([tt, x]) => ({ t: tt, x })), [rv]);
  // the player's own result always carries these; only other people's live results are masked
  const x = r.x ?? 1, soldT = r.soldT ?? r.T, peak = r.peak ?? { x, t: soldT };

  return (
    <div className="fade-up space-y-3">
      <div className="text-center">
        <div className="text-xs font-semibold tracking-widest text-primary">{t(`game.persona.${persona}` as DictKey)}</div>
        <div className={cn("font-mono text-5xl font-black tabular-nums", r.up ? "text-up" : "text-down")}>{times(x)}</div>
        <div className="mt-1 text-sm">{t(r.held ? "game.result.held" : "game.result.sold").replace("{x}", times(x))}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {(r.held ? t("game.result.topHeld") : t("game.result.top")).replace("{x}", times(peak.x)).replace("{t}", clock(peak.t, zh)).replace("{s}", clock(soldT, zh))}
        </div>
        <div className="mt-2 flex justify-center"><Squares r={r} big /></div>
        <div className="text-xs text-muted-foreground">
          {r.up ? t("game.result.capture").replace("{p}", pct(r.capture)) : t("game.result.loss").replace("{p}", pct(1 - x))}
          {" · "}
          {!r.counted ? t("game.result.practice") : r.beat === null ? t("game.result.first") : t("game.result.beat").replace("{p}", pct(r.beat)).replace("{n}", String(r.others + 1))}
          {r.ranked && <> · <span className="text-primary">{t("game.result.ranked")}</span></>}
        </div>
      </div>

      {rv && (
        <>
          <Chart pts={pts} now={r.T} T={r.T} entryT={r.entry.t} sold={{ t: soldT, x }} peak={peak} live={false} />
          <div className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-xs leading-relaxed">
            {coin ? (
              <p>
                {t("game.result.reveal").replace("{s}", coin.symbol || "?").replace("{d}", new Date(coin.bornAt).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" })).replace("{x}", times(coin.nowX))}
                {" "}
                <Link href={`/tools?tab=replay`} className="text-primary hover:underline">{t("tools.tab.replay")}</Link>
                {" · "}
                <a href={`https://www.geckoterminal.com/arc/pools/${coin.pool}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">GeckoTerminal</a>
              </p>
            ) : (
              <p>{t("game.result.hidden")}</p>
            )}
            <p className="text-muted-foreground">{t("game.result.insiders").replace("{v}", money(rv.insidersPnl)).replace("{r}", money(rv.retailPnl))}</p>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button asChild variant="glow"><a href={intent} target="_blank" rel="noreferrer">{t("game.share")}</a></Button>
        <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(`${tweet}\n${share}`).then(() => toast.success(t("game.copied"))); }}>
          <Copy /> {t("game.copy")}
        </Button>
      </div>
      <Button variant="ghost" size="sm" className="w-full" onClick={onAgain}><RotateCcw /> {t("game.again")}</Button>
    </div>
  );
}

function Board() {
  const { t } = useApp();
  const b = useGameBoard();
  const top = b.data?.top ?? [];
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <h2 className="flex items-center gap-1.5 font-semibold"><Trophy className="size-4 text-gold" /> {t("game.board")}</h2>
        {top.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("game.boardEmpty")}</p>
        ) : (
          <ol className="space-y-1">
            {top.map((w, i) => (
              <li key={w.id} className="flex items-center gap-2 font-mono text-xs tabular-nums">
                <span className="w-5 text-right text-muted-foreground">{i + 1}</span>
                <span className="flex-1 truncate">{shortAddr(w.wallet)}</span>
                {w.x === null
                  ? <Squares r={w} />
                  : <span className={w.up ? "text-up" : "text-down"}>{times(w.x)}</span>}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export function SellTop({ shared }: { shared?: string }) {
  const { t, locale, connected, address, toggleConnect } = useApp();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const { signMessageAsync } = useSignMessage();
  const today = useGameToday();
  const friend = useGamePlay(shared);
  const nowMs = useNow(1000);
  const [session, setSession] = useState<GameSession | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [mineId, setMineId] = useState<string | null>(null);
  const [rank, setRank] = useState(true);
  const [busy, setBusy] = useState(false);
  const d = today.data?.status === "ready" ? today.data : null;

  // a round left mid-way (reload) resumes on the server clock; a finished one shows its result
  useEffect(() => {
    if (!d) return;
    void Promise.resolve(readStored(d.day)).then((st) => {
      if (!st) return;
      setMineId(st.id);
      if (st.result) { setResult(st.result); return; }
      return gameSession(st.id).then((s) => (s.sold ? gameSell(st.id).then(setResult) : setSession(s)));
    }).catch(() => {});
  }, [d?.day]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = useCallback((r: GameResult) => {
    setSession(null);
    setResult(r);
    // r.id is the public share id; the stored id stays the private session key
    const st = readStored(r.day);
    if (st && (r.counted || !st.result)) writeStored(r.day, { id: st.id, result: r });
    void qc.invalidateQueries({ queryKey: ["game"] });
  }, [qc]);

  const start = async () => {
    if (!d) return;
    setBusy(true);
    try {
      let body: { wallet?: string; ts?: number; sig?: string } = {};
      if (connected && address && rank && !mineId) {
        const ts = Date.now();
        const sig = await signMessageAsync({ message: gameSignMessage(address, d.day, ts) });
        body = { wallet: address, ts, sig };
      }
      const s = await gameStart(body);
      if (!mineId) { writeStored(s.day, { id: s.id }); setMineId(s.id); }
      setResult(null);
      setSession(s);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const fr = friend.data;
  return (
    <div className="space-y-4">
      {fr && !result && !session && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="p-3 text-sm">
            {fr.x !== null && !fr.live
              ? t("game.sharedPast").replace("{n}", String(fr.n)).replace("{x}", times(fr.x)).replace("{p}", fr.up ? pct(fr.capture) : "0%")
              : fr.beat !== null && fr.others > 0
                ? t("game.shared").replace("{persona}", t(`game.persona.${personaOf(fr)}` as DictKey)).replace("{beat}", pct(fr.beat))
                : t("game.sharedFirst").replace("{persona}", t(`game.persona.${personaOf(fr)}` as DictKey))}
            <div className="mt-1.5"><Squares r={fr} big /></div>
          </CardContent>
        </Card>
      )}

      <Card className="border-primary/30">
        <CardContent className="space-y-3 p-4 text-sm">
          {today.isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : today.data?.status === "syncing" ? (
            <p className="text-muted-foreground">{t("game.syncing").replace("{p}", String(Math.round(today.data.progress * 100)))}</p>
          ) : !d ? (
            <p className="text-muted-foreground">{t("game.none")}</p>
          ) : session ? (
            <Round key={session.id} s={session} onDone={done} />
          ) : result ? (
            <Result r={result} onAgain={() => void start()} />
          ) : (
            <div className="space-y-3">
              <div>
                <h1 className="flex items-center gap-2 text-xl font-bold"><Mountain className="size-5 text-primary" /> {t("game.title").replace("{n}", String(d.n))}</h1>
                <p className="mt-1 text-base font-semibold">{t("game.tagline").replace("{rank}", String(d.entry.rank))}</p>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                <li>{t("game.rule.1")}</li>
                <li>{t("game.rule.2").replace("{t}", clock(d.entry.t, zh)).replace("{ahead}", String(d.entry.ahead))}</li>
                <li>{t("game.rule.3").replace("{s}", String(Math.round(d.durMs / 1000)))}</li>
                <li>{t("game.rule.4")}</li>
              </ul>
              <Button size="xl" variant="glow" className="h-14 w-full text-lg font-bold" disabled={busy} onClick={() => void start()}>
                {busy ? <Loader2 className="animate-spin" /> : t("game.start")}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                {connected ? (
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input type="checkbox" checked={rank} onChange={(e) => setRank(e.target.checked)} className="accent-[var(--primary)]" />
                    {t("game.signToRank")}
                  </label>
                ) : (
                  <button type="button" onClick={toggleConnect} className="inline-flex items-center gap-1 hover:text-foreground"><Wallet className="size-3.5" /> {t("game.connectToRank")}</button>
                )}
                <span>{t("game.rankRule")}</span>
              </div>
            </div>
          )}
          {d && (
            <div className="flex flex-wrap justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
              <span>{d.players ? t("game.today").replace("{n}", String(d.players)).replace("{x}", d.avgX ? times(d.avgX) : "—") : t("game.todayNone")}</span>
              <span className="font-mono tabular-nums">{t("game.next").replace("{t}", hms(d.nextAt - nowMs))}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {d?.yesterday && (
        <p className="px-1 text-xs text-muted-foreground">
          {t("game.yesterday").replace("{n}", String(d.yesterday.n)).replace("{s}", d.yesterday.symbol || "?").replace("{x}", times(d.yesterday.peakX))
            .replace("{p}", String(d.yesterday.players)).replace("{a}", d.yesterday.avgX ? times(d.yesterday.avgX) : "—")}
        </p>
      )}
      <Board />
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("game.legend")}</p>
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("game.note")}</p>
    </div>
  );
}
