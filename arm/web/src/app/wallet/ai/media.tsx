"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, CheckCircle, CircleNotch, DownloadSimple, FilmStrip, Image as ImageIcon, MagnifyingGlass, MusicNotes, PencilSimple, SpeakerHigh, Waveform, ChatCircleDots, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { explorerTx } from "@/lib/wallet/chains";
import { t } from "@/lib/wallet/i18n";
import { AI_CHAIN, mediaSrc, refSrc, usd6, videoDurations, type ChatMsg, type ChatStore, type MediaKind, type MediaModel, type MediaVoice, type Mode } from "@/lib/wallet/x402";

export const MODES: Mode[] = ["chat", "image", "video", "speech", "music", "sfx"];
export const MODE_ICON = { chat: ChatCircleDots, image: ImageIcon, video: FilmStrip, speech: SpeakerHigh, music: MusicNotes, sfx: Waveform } as const;
const SFX_SECS = [0, 3, 5, 10];

/** BlockRun lists prices before its 5% margin; the quote in the confirm sheet is exact */
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(3).replace(/0+$/, "") : v.toFixed(2).replace(/\.?0+$/, "")}`;
const sizePrice = (m: MediaModel, size?: string) => m.sizes?.find((s) => s.size === size)?.price ?? m.price;
export function mediaPriceLabel(m: MediaModel, opts: ChatStore["opts"]) {
  if (m.kind === "image") return t("cw.aichat.unit.image", { v: usd(sizePrice(m, opts.size)) });
  if (m.kind === "video") {
    const sec = pickSec(m, opts.sec);
    return `${t("cw.aichat.unit.second", { v: usd(m.price) })} · ${t("cw.aichat.estimate", { v: usd(m.price * sec * 1.05) })}`;
  }
  return t(`cw.aichat.unit.${m.unit}`, { v: usd(m.price) });
}
/** the shortest clip unless one was picked: video is billed per second */
export const pickSec = (m: MediaModel | undefined, sec?: number) => {
  const all = videoDurations(m);
  return sec && all.includes(sec) ? sec : all[0];
};
export const pickSize = (m: MediaModel | undefined, size?: string) => (m?.sizes?.some((s) => s.size === size) ? size : m?.sizes?.[0]?.size);

const RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "2:1", "1:2"];
function ratioLabel(size: string) {
  const [w, h] = size.split("x").map(Number);
  const ratio = RATIOS.reduce((best, r) => {
    const [a, b] = r.split(":").map(Number);
    const [ba, bb] = best.split(":").map(Number);
    return Math.abs(Math.log(w / h / (a / b))) < Math.abs(Math.log(w / h / (ba / bb))) ? r : best;
  });
  const big = Math.max(w, h);
  return big >= 4000 ? `${ratio} · 4K` : big >= 2000 ? `${ratio} · 2K` : ratio;
}

export function ModeTabs({ mode, onPick }: { mode: Mode; onPick: (m: Mode) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1 rounded-2xl bg-muted p-1">
      {MODES.map((m) => {
        const Icon = MODE_ICON[m];
        return (
          <button key={m} type="button" onClick={() => onPick(m)} className={cn("flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold transition", m === mode ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}>
            <Icon size={16} weight={m === mode ? "fill" : "regular"} />
            {t(`cw.aichat.mode.${m}`)}
          </button>
        );
      })}
    </div>
  );
}

const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" onClick={onClick} className={cn("h-8 shrink-0 rounded-xl px-3 text-[12px] font-semibold transition active:scale-95", on ? "bg-foreground text-background" : "bg-card ring-1 ring-border/60")}>
    {children}
  </button>
);

/** size / duration / voice / vocals for the current media kind */
export function OptionsBar({ kind, model, opts, voices, onOpts, onVoice }: { kind: MediaKind; model?: MediaModel; opts: ChatStore["opts"]; voices: MediaVoice[]; onOpts: (o: ChatStore["opts"]) => void; onVoice: () => void }) {
  let chips: React.ReactNode = null;
  if (kind === "image" && model?.sizes && model.sizes.length > 1) {
    const cur = pickSize(model, opts.size);
    chips = model.sizes.map((s) => (
      <Chip key={s.size} on={s.size === cur} onClick={() => onOpts({ ...opts, size: s.size })}>
        {ratioLabel(s.size)}
      </Chip>
    ));
  } else if (kind === "video") {
    const cur = pickSec(model, opts.sec);
    chips = videoDurations(model).map((s) => (
      <Chip key={s} on={s === cur} onClick={() => onOpts({ ...opts, sec: s })}>
        {t("cw.aichat.secs", { n: s })}
      </Chip>
    ));
  } else if (kind === "speech") {
    const v = voices.find((x) => x.id === (opts.voice ?? "sarah"));
    chips = (
      <Chip on={false} onClick={onVoice}>
        {t("cw.aichat.voice", { v: v?.name ?? opts.voice ?? "Sarah" })} ▾
      </Chip>
    );
  } else if (kind === "music") {
    const inst = opts.instrumental !== false;
    chips = (
      <>
        <Chip on={inst} onClick={() => onOpts({ ...opts, instrumental: true })}>
          {t("cw.aichat.instrumental")}
        </Chip>
        <Chip on={!inst} onClick={() => onOpts({ ...opts, instrumental: false })}>
          {t("cw.aichat.vocal")}
        </Chip>
      </>
    );
  } else if (kind === "sfx") {
    chips = SFX_SECS.map((s) => (
      <Chip key={s} on={(opts.sfxSec ?? 0) === s} onClick={() => onOpts({ ...opts, sfxSec: s })}>
        {s ? t("cw.aichat.secs", { n: s }) : t("cw.aichat.autoLen")}
      </Chip>
    ));
  }
  if (!chips) return null;
  return <div className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto">{chips}</div>;
}

/** request body for /x402/gen/:kind; `ref` is a reference image (image → image, image → video) */
export function mediaBody(kind: MediaKind, model: string, prompt: string, m: MediaModel | undefined, opts: ChatStore["opts"], ref?: string | null): object {
  if (kind === "image") {
    const size = pickSize(m, opts.size);
    return { model, prompt, ...(ref ? { image: ref } : {}), ...(size ? { size } : {}) };
  }
  if (kind === "video") return { model, prompt, ...(ref ? { image_url: ref } : {}), duration_seconds: pickSec(m, opts.sec) };
  if (kind === "speech") return { model, input: prompt, voice: opts.voice ?? "sarah" };
  if (kind === "music") return { model, prompt, instrumental: opts.instrumental !== false };
  return opts.sfxSec ? { model, text: prompt, duration_seconds: opts.sfxSec } : { model, text: prompt };
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</>;
}

/** an assistant message carrying generated files (or a video still being made) */
export function MediaBubble({ m, onUse }: { m: ChatMsg; onUse?: (url: string, as: "image" | "video") => void }) {
  const urls = m.urls ?? [];
  if (!urls.length && m.job && !m.error) {
    return (
      <div className="flex flex-col items-start">
        <div className="w-[78%] rounded-[20px] rounded-bl-md bg-card px-4 py-3 ring-1 ring-border/60">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <CircleNotch size={16} className="animate-spin text-primary" />
            {t("cw.aichat.videoWait")} <span className="font-mono text-muted-foreground"><Elapsed since={m.job.since} /></span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t("cw.aichat.videoHint")}</p>
        </div>
        <Footer m={m} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <div className="flex w-full flex-col items-start gap-2">
        {urls.map((u) => {
          const src = mediaSrc(u);
          if (m.kind === "image")
            return (
              <div key={u} className="w-[78%]">
                <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[20px] rounded-bl-md bg-muted ring-1 ring-border/60">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" loading="lazy" className="block h-auto w-full" />
                </a>
                {onUse && (
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <button type="button" onClick={() => onUse(u, "image")} className="flex h-8 items-center justify-center gap-1 rounded-xl bg-card text-[12px] font-semibold ring-1 ring-border/60 transition active:scale-95">
                      <PencilSimple size={13} />
                      {t("cw.aichat.useEdit")}
                    </button>
                    <button type="button" onClick={() => onUse(u, "video")} className="flex h-8 items-center justify-center gap-1 rounded-xl bg-card text-[12px] font-semibold ring-1 ring-border/60 transition active:scale-95">
                      <FilmStrip size={13} />
                      {t("cw.aichat.useVideo")}
                    </button>
                  </div>
                )}
              </div>
            );
          if (m.kind === "video") return <Video key={u} src={src} />;
          return (
            <div key={u} className="w-[86%] rounded-[20px] rounded-bl-md bg-card p-2 ring-1 ring-border/60">
              <audio src={src} controls preload="metadata" className="block w-full" />
            </div>
          );
        })}
      </div>
      <Footer m={m} />
    </div>
  );
}

/** H.264 mp4; browsers built without that codec get a pointer to the file instead of a dead player */
function Video({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <a href={src} target="_blank" rel="noreferrer" className="flex w-[78%] items-center gap-2 rounded-[20px] rounded-bl-md bg-card px-4 py-3 text-[13px] ring-1 ring-border/60">
        <FilmStrip size={18} className="shrink-0 text-primary" />
        {t("cw.aichat.videoNoPlay")}
      </a>
    );
  return <video src={src} controls playsInline preload="metadata" onError={() => setBroken(true)} className="w-[78%] rounded-[20px] rounded-bl-md bg-black" />;
}

function Footer({ m }: { m: ChatMsg }) {
  const url = m.urls?.[0];
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-[11px] text-muted-foreground">
      <span className="max-w-[150px] truncate">{m.model}</span>·<span className="font-mono">{t("cw.aichat.paid", { v: usd6(m.cost ?? "0") })}</span>
      {m.tx && (
        <a href={explorerTx(AI_CHAIN, m.tx)} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 underline-offset-2 hover:underline">
          {t("cw.aichat.viewTx")}
          <ArrowSquareOut size={11} />
        </a>
      )}
      {url && (
        <a href={mediaSrc(url)} target="_blank" rel="noreferrer" download className="flex items-center gap-0.5 underline-offset-2 hover:underline">
          {t("cw.aichat.save")}
          <DownloadSimple size={11} />
        </a>
      )}
    </div>
  );
}

/** small tag above a media prompt so the timeline reads 「图片 · …」, with its reference image if any */
export function KindTag({ kind, refImg }: { kind: MediaKind; refImg?: string }) {
  const Icon = MODE_ICON[kind];
  return (
    <>
      <span className="mb-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
        <Icon size={12} />
        {t(`cw.aichat.mode.${kind}`)}
        {refImg && ` · ${t(kind === "video" ? "cw.aichat.refVideo" : "cw.aichat.refImage")}`}
      </span>
      {refImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={refSrc(refImg)} alt="" className="mb-1 size-20 rounded-2xl object-cover ring-1 ring-border/60" />
      )}
    </>
  );
}

/** the reference image waiting above the composer */
export function RefChip({ src, kind, uploading, onClear }: { src: string | null; kind: MediaKind; uploading: boolean; onClear: () => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-2xl bg-card p-1.5 pr-3 ring-1 ring-border/60">
      <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {src && <img src={src} alt="" className="size-full object-cover" />}
        {uploading && <CircleNotch size={18} className="absolute animate-spin text-primary" />}
      </span>
      <span className="min-w-0 flex-1 text-[12px] leading-4">
        <span className="block font-semibold">{t(kind === "video" ? "cw.aichat.refVideo" : "cw.aichat.refImage")}</span>
        <span className="block text-muted-foreground">{uploading ? t("cw.aichat.uploading") : t(kind === "video" ? "cw.aichat.refVideoHint" : "cw.aichat.refImageHint")}</span>
      </span>
      <button type="button" aria-label={t("cw.aichat.refRemove")} onClick={onClear} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted transition active:scale-90">
        <X size={14} />
      </button>
    </div>
  );
}

export function MediaModelSheet({ models, loading, current, opts, note, onPick }: { models: MediaModel[]; loading: boolean; current?: string; opts: ChatStore["opts"]; note?: string; onPick: (id: string) => void }) {
  return (
    <div>
      <div className="mb-2 text-center text-[17px] font-semibold">{t("cw.aichat.pickModel")}</div>
      {note && <p className="mb-2 px-1 text-center text-[12px] text-muted-foreground">{note}</p>}
      {loading && <div className="py-10 text-center text-[13px] text-muted-foreground">…</div>}
      <ul>
        {[...models]
          .sort((a, b) => a.price - b.price)
          .map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onPick(m.id)} className="flex w-full items-center gap-3 rounded-2xl px-1 py-2.5 text-left transition active:bg-muted">
                <Mark owner={m.owner} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{m.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {m.owner} · {mediaPriceLabel(m, { ...opts, size: undefined, sec: undefined })}
                  </span>
                </span>
                {m.id === current && <CheckCircle size={18} weight="fill" className="shrink-0 text-primary" />}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

export function VoiceSheet({ voices, current, onPick }: { voices: MediaVoice[]; current?: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return voices.filter((v) => !s || `${v.name} ${v.desc} ${v.gender} ${v.accent}`.toLowerCase().includes(s));
  }, [voices, q]);
  return (
    <div>
      <div className="mb-3 text-center text-[17px] font-semibold">{t("cw.aichat.pickVoice")}</div>
      <label className="flex h-11 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.aichat.searchVoice")} className="flex-1 bg-transparent text-[14px] outline-none" />
      </label>
      <p className="mt-2 px-1 text-[11px] leading-4 text-muted-foreground">{t("cw.aichat.voiceNote")}</p>
      <ul className="mt-2">
        {list.map((v) => (
          <li key={v.id}>
            <button type="button" onClick={() => onPick(v.id)} className="flex w-full items-center gap-3 rounded-2xl px-1 py-2.5 text-left transition active:bg-muted">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white" style={{ background: v.gender === "female" ? "#e8577e" : v.gender === "male" ? "#3f6ad8" : "#6b7280" }}>
                {v.name[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold">{v.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{[v.desc, v.accent].filter(Boolean).join(" · ")}</span>
              </span>
              {v.id === current && <CheckCircle size={18} weight="fill" className="shrink-0 text-primary" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const OWNER_COLORS: Record<string, string> = { openai: "#10a37f", google: "#4285f4", xai: "#111111", zai: "#2d5bff", bytedance: "#325ab4", azure: "#0078d4", minimax: "#e8414e", elevenlabs: "#000000" };
function Mark({ owner }: { owner: string }) {
  return (
    <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white uppercase" style={{ background: OWNER_COLORS[owner] ?? "#6b7280" }}>
      {owner[0]}
    </span>
  );
}

