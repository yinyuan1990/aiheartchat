"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronRight, Coins, ExternalLink, Flag, Heart, Loader2, Phone, RotateCcw, Share2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { useBoatAccount } from "@/components/boat/use-boat-account";
import { useBoatInfo } from "@/lib/boat";
import { storyEnd, storyStart, useStory, type Level, type Line, type StoryEnd, type T } from "@/lib/story";

type Item =
  | { k: "line"; line: Line }
  | { k: "pick"; text: string }
  | { k: "verdict"; ok: boolean; why: string; real: string };
type Run = { level: Level; id: string | null; token: string | null; startedAt: number };

const BG = "linear-gradient(180deg, #2b1233 0%, #160b1d 55%, #0e0813 100%)";
const PINK = "#ff5d8f";
const shuffle = (n: number) => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
/** a line "types" for longer the longer it is, so the chat reads like a chat */
const typingMs = (s: string) => Math.min(1800, 450 + s.length * 28);
const MIN_SECS = 26;
const now = () => Date.now();

export default function LoveGame() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const L = (t: T) => (zh ? t.zh : t.en);
  const acct = useBoatAccount();
  const info = useBoatInfo();
  const live = !!info.data?.enabled;
  const story = useStory(acct.token);
  const s = story.data;
  const [run, setRun] = useState<Run | null>(null);
  const [starting, setStarting] = useState<number | null>(null);
  const reward = Math.floor((s?.reward ?? 1000) * (s?.rate ?? 1));

  const start = async (level: Level) => {
    if (starting) return;
    let id: string | null = null;
    if (live && acct.token) {
      setStarting(level.id);
      try {
        const r = await storyStart(acct.token, level.id);
        if (r.practice) toast(zh ? `余额不足 ${s?.entry ?? 10}，这局是练习，不计奖励` : `Balance under ${s?.entry ?? 10}: practice, no reward`);
        id = r.id ?? null;
        void acct.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        setStarting(null);
        return;
      }
      setStarting(null);
    }
    setRun({ level, id, token: acct.token, startedAt: now() });
  };

  if (run) {
    return (
      <Shell>
        <Play key={`${run.level.id}-${run.startedAt}`} run={run} zh={zh} L={L} hearts={s?.hearts ?? 3} reward={reward}
          onExit={() => { setRun(null); void story.refetch(); }}
          onNext={(lv) => { setRun(null); void story.refetch().then(() => void start(lv)); }}
          next={s?.levels.find((l) => l.id === run.level.id + 1) ?? null} />
      </Shell>
    );
  }

  const me = acct.me;
  const balance = me ? me.bonus + me.cash : 0;
  return (
    <Shell>
      <div className="mx-auto flex h-full w-full max-w-md flex-col overflow-y-auto px-5 pb-10">
        <div className="flex items-center justify-between py-4">
          <Link href="/games" className="flex size-10 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.08)" }} aria-label={zh ? "返回" : "Back"}><ArrowLeft className="size-5" /></Link>
          {live && me && <span className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm" style={{ background: "rgba(255,255,255,0.08)" }}><Coins className="size-4 text-amber-300" /><b className="font-mono">{balance.toLocaleString()}</b> BOAT</span>}
        </div>
        <div className="mt-4 text-center">
          <div className="text-5xl">🛡️💘</div>
          <h1 className="mt-3 text-4xl font-black tracking-tight">{zh ? "清醒局" : "Stay Sharp"}</h1>
          <p className="mt-1 text-base font-semibold" style={{ color: PINK }}>{zh ? "防捞女剧情游戏" : "An anti-gold-digger story game"}</p>
          <p className="mx-auto mt-3 max-w-sm text-sm opacity-80">
            {zh
              ? "根据真实事件改编的聊天剧情。每到关键时刻做一个选择：踩中红旗扣一颗心，三颗心扣完就失败。每关讲完，告诉你现实里发生了什么。"
              : "Chat stories adapted from real cases. At each turning point you choose: miss a red flag and lose a heart; lose all three and it's over. After each level you learn what really happened."}
          </p>
        </div>

        {live && (
          <div className="mt-5 rounded-2xl px-4 py-3 text-sm" style={{ background: "rgba(255,255,255,0.07)" }}>
            {me ? (
              <span className="opacity-90">{zh ? `每关第一次通关得 ${reward.toLocaleString()} BOAT（每个钱包每关一次）。没通关前每次进入门票 ${s?.entry ?? 10}，通关后免费重玩。` : `Clear a level for the first time: ${reward.toLocaleString()} BOAT (once per wallet per level). ${s?.entry ?? 10} BOAT a try until you clear it, then replays are free.`}</span>
            ) : (
              <button type="button" className="flex w-full items-center justify-center gap-2 font-semibold" onClick={() => void acct.login()} disabled={acct.busy}>
                {acct.busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                {!acct.connected ? (zh ? `连钱包，送 100 BOAT，通关每关得 ${reward}` : `Connect a wallet: 100 BOAT, ${reward} per level cleared`) : (zh ? `签名登录，通关每关得 ${reward} BOAT` : `Sign in: ${reward} BOAT per level cleared`)}
              </button>
            )}
          </div>
        )}

        <div className="mt-5 space-y-3">
          {!s ? <div className="flex justify-center py-10"><Loader2 className="size-6 animate-spin opacity-70" /></div> : s.levels.map((lv) => {
            const done = s.cleared[lv.id] !== undefined;
            return (
              <div key={lv.id} className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${done ? "rgba(74,222,128,0.45)" : "rgba(255,255,255,0.1)"}` }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-bold">{L(lv.title)}</div>
                    <div className="text-sm" style={{ color: PINK }}>{L(lv.tagline)}</div>
                    <div className="mt-1 text-xs opacity-60">{L(lv.basedOn)}</div>
                  </div>
                  {done && <span className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-black" style={{ background: "#4ade80" }}><Check className="size-3" />{zh ? "已通关" : "Cleared"}</span>}
                </div>
                <Button className="mt-3 h-11 w-full rounded-full font-bold" disabled={!!starting} onClick={() => void start(lv)} style={{ background: PINK, color: "#fff" }}>
                  {starting === lv.id && <Loader2 className="animate-spin" />}
                  {!live || !me ? (zh ? "开始（不计奖励）" : "Play (no reward)")
                    : done ? (zh ? "免费重玩" : "Replay free")
                    : (zh ? `开始 · 门票 ${s.entry} · 通关 +${reward}` : `Play · ${s.entry} BOAT · clear +${reward}`)}
                </Button>
              </div>
            );
          })}
          <p className="pt-1 text-center text-xs opacity-60">{zh ? "更多关卡陆续加入" : "More levels coming"}</p>
        </div>

        <p className="mt-6 text-[11px] leading-relaxed opacity-55">
          {zh
            ? "根据公开报道改编，人物均为化名，对话和部分细节为虚构，真实经过以每关结尾的官方通报 / 判决为准。游戏想提醒的是恋爱里的风险，不针对任何性别。如果你或身边的人正处在情绪危机中，请拨打全国心理援助热线 12356。"
            : "Adapted from public reports. Everyone is renamed and the chats and some details are invented; the real facts are the police report / court ruling quoted at the end of each level. The game is about risks in relationships, not about any gender. If you or someone near you is in crisis, call China's mental-health helpline 12356 or your local emergency number."}
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] select-none overflow-hidden text-white" style={{ background: BG }}>
      <style>{"@keyframes love-dot{0%,80%,100%{opacity:.25}40%{opacity:1}}@keyframes love-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}"}</style>
      {children}
    </div>
  );
}

function Play({ run, zh, L, hearts: maxHearts, reward, onExit, onNext, next }: {
  run: Run; zh: boolean; L: (t: T) => string; hearts: number; reward: number; onExit: () => void; onNext: (lv: Level) => void; next: Level | null;
}) {
  const lv = run.level;
  const [items, setItems] = useState<Item[]>([]);
  const [step, setStep] = useState(0);
  const [line, setLine] = useState(0);
  const [phase, setPhase] = useState<"lines" | "ask" | "verdict" | "end">("lines");
  const [hearts, setHearts] = useState(maxHearts);
  const [picks, setPicks] = useState<number[]>([]);
  const [end, setEnd] = useState<StoryEnd | null>(null);
  const [ending, setEnding] = useState(false);
  const orders = useMemo(() => lv.steps.map((st) => shuffle(st.choices.length)), [lv]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const cur = lv.steps[step];
  const failed = hearts <= 0;
  // the line about to appear "types" first (narration just fades in)
  const pending = phase === "lines" ? cur?.lines[line] : undefined;
  const typing = !!pending && pending.who !== "nar";

  // reveal the step's lines one by one; a tap skips the wait
  const reveal = () => {
    if (phase !== "lines" || !cur) return;
    if (line >= cur.lines.length) { setPhase("ask"); return; }
    const l = cur.lines[line];
    setItems((x) => [...x, { k: "line", line: l }]);
    setLine(line + 1);
  };
  useEffect(() => {
    if (phase !== "lines" || !cur) return;
    const l = cur.lines[line];
    const wait = l ? (l.who === "nar" ? 700 : typingMs(L(l.t))) : 500;
    timer.current = setTimeout(reveal, line === 0 && step === 0 ? 500 : wait);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, step, line]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [items.length, phase, typing]);

  const choose = (i: number) => {
    const ch = cur.choices[i];
    setItems((x) => [...x, { k: "pick", text: L(ch.t) }, { k: "verdict", ok: ch.ok, why: L(ch.why), real: L(cur.real) }]);
    setPicks((p) => [...p, i]);
    if (!ch.ok) setHearts((h) => h - 1);
    setPhase("verdict");
  };
  const proceed = () => {
    if (failed || step + 1 >= lv.steps.length) { void finish(); return; }
    setStep(step + 1);
    setLine(0);
    setPhase("lines");
  };
  const finish = async () => {
    setPhase("end");
    if (failed || !run.id || !run.token) return;
    setEnding(true);
    const left = MIN_SECS * 1000 - (Date.now() - run.startedAt);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    try {
      setEnd(await storyEnd(run.token, run.id, picks));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnding(false);
    }
  };
  const share = () => {
    const text = zh ? `我在「清醒局」防捞女剧情游戏里通过了「${L(lv.title)}」🛡️ 你能看出几个红旗？` : `I cleared "${L(lv.title)}" in Stay Sharp, an anti-gold-digger story game 🛡️ How many red flags can you spot?`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${location.origin}/love`)}`, "_blank", "noopener");
  };

  const herName = L(lv.her);
  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col">
      <div className="flex items-center gap-3 px-4 py-3" style={{ background: "rgba(0,0,0,0.25)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <button type="button" onClick={onExit} className="flex size-9 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.08)" }} aria-label={zh ? "返回" : "Back"}><ArrowLeft className="size-5" /></button>
        <Avatar name={herName} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{herName}</div>
          <div className="truncate text-xs opacity-60">{typing ? (zh ? "对方正在输入…" : "typing…") : L(lv.title)}</div>
        </div>
        <div className="flex gap-0.5">
          {Array.from({ length: maxHearts }, (_, i) => <Heart key={i} className="size-5" fill={i < hearts ? PINK : "transparent"} stroke={i < hearts ? PINK : "rgba(255,255,255,0.35)"} />)}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" onClick={() => { if (phase === "lines") { if (timer.current) clearTimeout(timer.current); reveal(); } }}>
        {items.map((it, i) => <Bubble key={i} it={it} zh={zh} L={L} herName={herName} />)}
        {typing && phase === "lines" && (
          <div className="flex items-end gap-2"><Avatar name={herName} small /><div className="rounded-2xl rounded-bl-md px-4 py-3" style={{ background: "rgba(255,255,255,0.1)" }}>
            {[0, 1, 2].map((d) => <span key={d} className="mx-0.5 inline-block size-1.5 rounded-full bg-white" style={{ animation: `love-dot 1.2s ${d * 0.2}s infinite` }} />)}
          </div></div>
        )}
        {phase === "lines" && <p className="pt-2 text-center text-[11px] opacity-40">{zh ? "点屏幕跳过等待" : "Tap to skip"}</p>}
        <div ref={bottom} />
      </div>

      {phase === "ask" && (
        <div className="space-y-2 px-4 pb-6 pt-3" style={{ background: "rgba(0,0,0,0.35)", borderTop: "1px solid rgba(255,255,255,0.08)", animation: "love-in .25s ease-out" }}>
          <div className="text-sm font-semibold opacity-90">{L(cur.ask)}</div>
          {orders[step].map((i) => (
            <button key={i} type="button" onClick={() => choose(i)} className="block w-full rounded-xl px-4 py-3 text-left text-sm font-medium transition-opacity active:opacity-70" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.14)" }}>
              {L(cur.choices[i].t)}
            </button>
          ))}
        </div>
      )}

      {phase === "verdict" && (
        <div className="px-4 pb-6 pt-3" style={{ background: "rgba(0,0,0,0.35)" }}>
          <Button className="h-12 w-full rounded-full text-base font-bold" style={{ background: PINK, color: "#fff" }} onClick={proceed}>
            {failed ? (zh ? "防线失守，看结局" : "Your guard is down: see the ending") : step + 1 >= lv.steps.length ? (zh ? "看结局" : "See the ending") : (zh ? "继续" : "Continue")}<ChevronRight />
          </Button>
        </div>
      )}

      {phase === "end" && (
        <div className="absolute inset-0 z-10 overflow-y-auto" style={{ background: BG }}>
          <div className="mx-auto max-w-md space-y-4 px-5 py-8">
            <div className="text-center">
              <div className="text-5xl">{failed ? "💔" : "🛡️"}</div>
              <div className="mt-2 text-3xl font-black">{failed ? (zh ? "防线失守" : "Guard down") : (zh ? "通关！" : "Cleared!")}</div>
              <div className="mt-1 text-sm opacity-80">{failed ? (zh ? "三颗心都扣完了，再来一次" : "All three hearts lost. Try again") : (zh ? `剩 ${hearts} 颗心` : `${hearts} heart${hearts === 1 ? "" : "s"} left`)}</div>
              {!failed && run.id && (
                <div className="mt-3 inline-block rounded-full px-4 py-1.5 font-bold text-black" style={{ background: "#fbbf24" }}>
                  {ending || !end ? <Loader2 className="size-4 animate-spin" /> : end.reward > 0 ? `+${end.reward.toLocaleString()} BOAT` : (zh ? "这关已领过奖励" : "Reward already claimed")}
                </div>
              )}
              {!failed && !run.id && <div className="mt-2 text-xs opacity-70">{zh ? `这局没计奖励。连钱包登录后，每关第一次通关得 ${reward} BOAT` : `Not rewarded. Sign in with a wallet: ${reward} BOAT for each level's first clear`}</div>}
            </div>

            <div className="rounded-2xl p-4" style={{ background: "rgba(255,93,143,0.12)", border: "1px solid rgba(255,93,143,0.35)" }}>
              <div className="mb-1 text-xs font-semibold" style={{ color: PINK }}>{zh ? "这一关想说的" : "The takeaway"}</div>
              <p className="text-sm leading-relaxed">{L(lv.lesson)}</p>
            </div>

            <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="mb-2 text-xs font-semibold opacity-70">{zh ? `真实经过 · ${L(lv.basedOn)}` : `What really happened · ${L(lv.basedOn)}`}</div>
              <ul className="space-y-2 text-sm leading-relaxed opacity-90">{lv.recap.map((r, i) => <li key={i}>· {L(r)}</li>)}</ul>
              <div className="mt-3 space-y-1">
                {lv.sources.map((src) => <a key={src.url} href={src.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs underline opacity-70">{src.name}<ExternalLink className="size-3" /></a>)}
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-2xl p-3 text-xs leading-relaxed" style={{ background: "rgba(255,255,255,0.05)" }}>
              <Phone className="mt-0.5 size-4 shrink-0" />
              {zh ? "如果你或身边的人正处在情绪危机中，请拨打全国心理援助热线 12356；遇到敲诈勒索请报警 110。" : "If you or someone near you is in crisis, call China's mental-health helpline 12356 or your local emergency number; report extortion to the police."}
            </div>

            <div className="flex flex-col gap-2">
              {!failed && next && <Button className="h-12 rounded-full text-base font-bold" style={{ background: PINK, color: "#fff" }} onClick={() => onNext(next)}>{zh ? "下一关：" : "Next level: "}{L(next.title)}<ChevronRight /></Button>}
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" className="h-11 rounded-full font-bold" onClick={onExit}><RotateCcw />{zh ? "选关" : "Levels"}</Button>
                <Button variant="secondary" className="h-11 rounded-full font-bold" onClick={share}><Share2 />{zh ? "晒到 X" : "Share"}</Button>
              </div>
              <Link href="/games" className="mt-1 text-center text-sm opacity-70 underline">{zh ? "返回游戏探索" : "Back to Games"}</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <div className={small ? "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold" : "flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold"}
      style={{ background: "linear-gradient(135deg, #ff8fb1, #c03a7a)" }}>
      {[...name][0]}
    </div>
  );
}

function Bubble({ it, zh, L, herName }: { it: Item; zh: boolean; L: (t: T) => string; herName: string }) {
  const anim = { animation: "love-in .25s ease-out" };
  if (it.k === "pick") {
    return <div className="flex justify-end" style={anim}><div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm" style={{ background: "#3b82f6" }}><span className="mr-1 opacity-70">{zh ? "你选择：" : "You:"}</span>{it.text}</div></div>;
  }
  if (it.k === "verdict") {
    return (
      <div className="space-y-2" style={anim}>
        <div className="rounded-2xl p-3 text-sm" style={{ background: it.ok ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.14)", border: `1px solid ${it.ok ? "rgba(74,222,128,0.45)" : "rgba(248,113,113,0.5)"}` }}>
          <div className="mb-1 flex items-center gap-1.5 font-bold" style={{ color: it.ok ? "#4ade80" : "#f87171" }}>
            {it.ok ? <><Check className="size-4" />{zh ? "清醒" : "Sharp"}</> : <><Flag className="size-4" />{zh ? "红旗 · 扣一颗心" : "Red flag · −1 heart"}</>}
          </div>
          <p className="leading-relaxed opacity-90">{it.why}</p>
        </div>
        <div className="rounded-2xl p-3 text-xs leading-relaxed" style={{ background: "rgba(255,255,255,0.06)" }}>
          <span className="font-semibold opacity-70">{zh ? "📰 " : "📰 "}</span>{it.real}
        </div>
      </div>
    );
  }
  const l = it.line;
  if (l.who === "nar") {
    return (
      <div className="flex flex-col items-center gap-1.5 py-1" style={anim}>
        {l.at && <span className="rounded-full px-2.5 py-0.5 text-[11px] opacity-70" style={{ background: "rgba(255,255,255,0.08)" }}>{L(l.at)}</span>}
        <p className="max-w-[90%] text-center text-[13px] leading-relaxed opacity-75">{L(l.t)}</p>
      </div>
    );
  }
  if (l.who === "net") {
    return <div className="mx-auto max-w-[85%] rounded-xl px-3 py-2 text-[13px]" style={{ background: "rgba(255,255,255,0.05)", border: "1px dashed rgba(255,255,255,0.18)", ...anim }}><span className="mr-1 opacity-60">💬 {zh ? "网友" : "Netizen"}</span>{L(l.t)}</div>;
  }
  if (l.who === "me") {
    return <div className="flex justify-end" style={anim}><div className="max-w-[78%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm" style={{ background: "#3b82f6" }}>{L(l.t)}</div></div>;
  }
  return (
    <div className="flex items-end gap-2" style={anim}>
      <Avatar name={herName} small />
      <div className="max-w-[78%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm" style={{ background: "rgba(255,255,255,0.12)" }}>{L(l.t)}</div>
    </div>
  );
}
