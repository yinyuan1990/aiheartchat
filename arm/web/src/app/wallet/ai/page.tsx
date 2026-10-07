"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatUnits } from "viem";
import { ArrowSquareOut, CaretDown, CheckCircle, CircleNotch, GearSix, ImageSquare, MagnifyingGlass, PaperPlaneRight, ShieldCheck, Sparkle, Trash, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { cn } from "@/lib/utils";
import { USDC_LOGO } from "@/lib/wallet/assets";
import { explorerTx } from "@/lib/wallet/chains";
import { t } from "@/lib/wallet/i18n";
import { AI_CHAIN, AI_MAX_TOKENS, DEFAULT_EDIT, DEFAULT_MEDIA, EDIT_MODELS, FEATURED, aiChat, aiGenerate, loadChat, perM, pollJob, refSrc, saveChat, uploadRef, useAiMedia, useAiModels, useAiUsdc, usd6, type AiModel, type ChatMsg, type ChatStore, type MediaKind, type MediaResult, type Mode } from "@/lib/wallet/x402";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, ChainGlyph, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";
import { KindTag, MediaBubble, MediaModelSheet, ModeTabs, OptionsBar, RefChip, VoiceSheet, mediaBody, mediaPriceLabel } from "./media";

/** auto-pay limits in micro-USDC; 0 = confirm every paid message */
const CAPS = [0n, 10_000n, 50_000n, 200_000n, 1_000_000n];
/** turns sent as context (each one is paid for again as input tokens) */
const HISTORY = 16;
const EXAMPLES: Record<Mode, string[]> = {
  chat: ["cw.aichat.ex1", "cw.aichat.ex2", "cw.aichat.ex3"],
  image: ["cw.aichat.ex.image1", "cw.aichat.ex.image2"],
  video: ["cw.aichat.ex.video1", "cw.aichat.ex.video2"],
  speech: ["cw.aichat.ex.speech1", "cw.aichat.ex.speech2"],
  music: ["cw.aichat.ex.music1", "cw.aichat.ex.music2"],
  sfx: ["cw.aichat.ex.sfx1", "cw.aichat.ex.sfx2"],
};

const priceLabel = (m: AiModel) => (m.free ? t("cw.aichat.free") : t("cw.aichat.perM", { i: perM(m.input), o: perM(m.output) }));
const usdcText = (v?: bigint) => (v == null ? "…" : Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export default function AiChatPage() {
  const router = useRouter();
  const { active, account, setChain } = useVault();
  const user = active?.address;
  const models = useAiModels();
  const usdc = useAiUsdc(user);
  const [store, setStore] = useState<ChatStore | null>(null);
  useEffect(() => {
    if (user) setStore(loadChat(user));
  }, [user]);
  const update = (f: (s: ChatStore) => ChatStore) =>
    setStore((s) => {
      if (!s || !user) return s;
      const n = f(s);
      saveChat(user, n);
      return n;
    });

  const media = useAiMedia();
  const mode: Mode = store?.mode ?? "chat";
  const kind = mode === "chat" ? null : mode;
  const model = models.data?.find((m) => m.id === store?.model);
  // reference image for image → image / image → video: our upload path or a BlockRun file URL
  const [ref, setRef] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const withRef = !!ref && (kind === "image" || kind === "video");
  const editing = withRef && kind === "image";
  const mediaId = kind ? (editing ? (store?.picks.edit ?? DEFAULT_EDIT) : (store?.picks[kind] ?? DEFAULT_MEDIA[kind])) : null;
  const mediaModel = media.data?.models.find((m) => m.id === mediaId);
  const pickFile = async (f?: File) => {
    if (!f) return;
    setUploading(true);
    setRef(null);
    try {
      setRef(await uploadRef(f));
    } catch (e) {
      toast.error((e as Error).message || t("cw.aichat.uploadFailed"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const takeRef = (url: string, as: "image" | "video") => {
    setRef(url);
    update((s) => ({ ...s, mode: as }));
  };
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [sheet, setSheet] = useState<null | "models" | "settings" | "voices">(null);
  const [ask, setAsk] = useState<{ amount: bigint; resolve: (ok: boolean) => void } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const count = store?.messages.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, busy]);

  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  const confirm = (amount: bigint) => new Promise<boolean>((resolve) => setAsk({ amount, resolve }));

  /** messages are keyed by `at` (ms timestamp, unique per page) */
  const patch = (at: number, f: (m: ChatMsg) => ChatMsg) => update((s) => ({ ...s, messages: s.messages.map((m) => (m.at === at ? f(m) : m)) }));
  const finish = (at: number, r: MediaResult) => {
    update((s) => ({ ...s, spent: (BigInt(s.spent) + r.cost).toString(), messages: s.messages.map((m) => (m.at === at ? { ...m, urls: r.urls, tx: r.tx, cost: r.cost.toString(), job: undefined } : m)) }));
    void usdc.refetch();
  };
  const fail = (at: number, e: unknown) => {
    const msg = (e as Error).message;
    patch(at, (m) => ({ ...m, content: msg === "locked" ? t("cw.aichat.locked") : msg || t("cw.aichat.failed"), error: true, job: undefined }));
  };

  // video jobs survive a reload: pick up any still pending once the wallet is open
  const resumed = useRef(new Set<number>());
  useEffect(() => {
    let alive = true;
    for (const m of store?.messages ?? []) {
      if (!m.job || m.urls?.length || m.error || resumed.current.has(m.at)) continue;
      resumed.current.add(m.at);
      pollJob(account, m.job, (sig) => patch(m.at, (x) => (x.job ? { ...x, job: { ...x.job, sig } } : x)), () => alive)
        .then((r) => finish(m.at, r))
        .catch((e) => ((e as Error).message === "locked" ? resumed.current.delete(m.at) : fail(m.at, e)));
    }
    return () => {
      alive = false;
      resumed.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, store === null]);

  const sendMedia = async (k: MediaKind, q: string) => {
    if (!store || !mediaId) return;
    const r0 = withRef ? ref : null;
    const mine: ChatMsg = { role: "user", content: q, kind: k, ...(r0 ? { ref: r0 } : {}), at: Date.now() };
    update((s) => ({ ...s, messages: [...s.messages, mine] }));
    setBusy(true);
    const at = mine.at + 1;
    let parked = false;
    try {
      const r = await aiGenerate(account, k, mediaBody(k, mediaId, q, mediaModel, store.opts, r0), BigInt(store.autoCap), confirm, (job) => {
        parked = true;
        setRef(null);
        resumed.current.add(at);
        update((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: "", kind: k, model: mediaId, cost: job.cost, job, at }] }));
        setBusy(false);
      });
      if (!r) {
        update((s) => ({ ...s, messages: s.messages.filter((m) => m !== mine) }));
        setInput(q);
        return;
      }
      if (!parked) update((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: "", kind: k, model: mediaId, at }] }));
      setRef(null);
      finish(at, r);
    } catch (e) {
      if (!parked) update((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: "", kind: k, at }] }));
      fail(at, e);
    } finally {
      if (!parked) setBusy(false);
    }
  };

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy || !store) return;
    setInput("");
    if (kind) return sendMedia(kind, q);
    const mine: ChatMsg = { role: "user", content: q, at: Date.now() };
    const history = [...store.messages.filter((m) => !m.error && !m.kind), mine].slice(-HISTORY).map(({ role, content }) => ({ role, content }));
    update((s) => ({ ...s, messages: [...s.messages, mine] }));
    setBusy(true);
    try {
      const r = await aiChat(account, store.model, history, BigInt(store.autoCap), confirm);
      if (!r) {
        update((s) => ({ ...s, messages: s.messages.filter((m) => m !== mine) }));
        setInput(q);
        return;
      }
      update((s) => ({
        ...s,
        spent: (BigInt(s.spent) + r.cost).toString(),
        messages: [...s.messages, { role: "assistant", content: r.content, model: r.model, cost: r.cost.toString(), tx: r.tx, at: Date.now() }],
      }));
      if (r.cost > 0n) void usdc.refetch();
    } catch (e) {
      const msg = (e as Error).message;
      update((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: msg === "locked" ? t("cw.aichat.locked") : msg || t("cw.aichat.failed"), error: true, at: Date.now() }] }));
    } finally {
      setBusy(false);
    }
  };

  const goChain = (path: string) => {
    setChain(AI_CHAIN.key);
    router.push(path);
  };
  const noUsdc = usdc.data === 0n && (!!kind || !model?.free);
  const cap = BigInt(store?.autoCap ?? "0");
  const current = kind ? { owner: mediaModel?.owner ?? mediaId?.split("/")[0] ?? "?", name: mediaModel?.name ?? mediaId ?? "…", price: mediaModel && store ? mediaPriceLabel(mediaModel, store.opts) : media.isError ? t("cw.aichat.modelsFailed") : "…" } : { owner: model?.owner ?? store?.model.split("/")[0] ?? "?", name: model?.name ?? store?.model ?? "…", price: model ? priceLabel(model) : models.isError ? t("cw.aichat.modelsFailed") : "…" };

  return (
    <WalletFrame>
      <TopBar
        title={t("cw.aichat.title")}
        back="/wallet"
        right={
          <span className="flex h-8 items-center gap-1.5 rounded-full bg-card pr-3 pl-1 font-mono text-[13px] font-medium ring-1 ring-border/60">
            <span className="relative">
              <TokenAvatar symbol="USDC" seed="base-usdc" logo={USDC_LOGO} size={22} className="rounded-full" />
              <span className="absolute -right-1 -bottom-1">
                <ChainGlyph chain={AI_CHAIN} size={11} />
              </span>
            </span>
            {usdcText(usdc.data)}
          </span>
        }
      />

      <div className="sticky top-14 z-10 bg-background/85 px-4 pb-2 backdrop-blur-xl">
        <ModeTabs mode={mode} onPick={(m) => update((s) => ({ ...s, mode: m }))} />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" data-model-bar onClick={() => setSheet("models")} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl bg-card px-3 py-2 text-left ring-1 ring-border/60 transition active:scale-[0.99]">
            <ModelMark owner={current.owner} size={30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold">{current.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{current.price}</span>
            </span>
            <CaretDown size={14} className="shrink-0 text-muted-foreground" />
          </button>
          <button type="button" aria-label={t("cw.aichat.settings")} onClick={() => setSheet("settings")} className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-card ring-1 ring-border/60 transition active:scale-95">
            <GearSix size={19} />
          </button>
        </div>
        {kind && store && <OptionsBar kind={kind} model={mediaModel} opts={store.opts} voices={media.data?.voices ?? []} onOpts={(o) => update((s) => ({ ...s, opts: o }))} onVoice={() => setSheet("voices")} />}
      </div>

      <div className="flex-1 space-y-3 px-4 pt-2 pb-4">
        {count === 0 && <Intro n={models.data?.length} mode={mode} onPick={(k) => void send(t(k))} />}
        {noUsdc && (
          <div className="rounded-2xl px-3.5 py-3 text-[12px] leading-5" style={{ background: "rgba(212,136,6,0.1)", color: "#b07005" }}>
            <div className="flex gap-1.5">
              <Warning size={15} className="mt-0.5 shrink-0" />
              <span>{t("cw.aichat.noUsdc")}</span>
            </div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => goChain("/wallet/receive")} className="h-8 rounded-xl bg-card px-3 text-[12px] font-semibold text-foreground">
                {t("cw.home.receive")}
              </button>
              <button type="button" onClick={() => goChain("/wallet/swap")} className="h-8 rounded-xl bg-foreground px-3 text-[12px] font-semibold text-background">
                {t("cw.home.swap")}
              </button>
            </div>
          </div>
        )}
        {store?.messages.map((m, i) => <Bubble key={`${m.at}-${i}`} m={m} onUse={takeRef} />)}
        {busy && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-2 rounded-[20px] rounded-bl-md bg-card px-4 py-3 ring-1 ring-border/60">
              <CircleNotch size={15} className="animate-spin" />
              {ask ? t("cw.aichat.waitPay") : kind ? t(`cw.aichat.busy.${kind}`) : t("cw.aichat.thinking")}
            </span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 z-10 bg-background/90 px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-xl">
        <button type="button" onClick={() => setSheet("settings")} className="mb-1.5 flex w-full items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck size={12} className="text-up" />
          {t("cw.aichat.spent", { v: usd6(store?.spent ?? "0") })} · {cap === 0n ? t("cw.aichat.autoPayOff") : t("cw.aichat.autoPay", { v: usd6(cap) })}
        </button>
        {(kind === "image" || kind === "video") && (ref || uploading) && <RefChip src={ref ? refSrc(ref) : null} kind={kind} uploading={uploading} onClear={() => setRef(null)} />}
        <div className={cn("flex items-end gap-2 rounded-[22px] bg-card p-1.5 ring-1 ring-border/70", kind === "image" || kind === "video" ? "pl-1.5" : "pl-4")}>
          {(kind === "image" || kind === "video") && (
            <>
              <button type="button" aria-label={t("cw.aichat.refAdd")} disabled={uploading || busy} onClick={() => fileRef.current?.click()} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition active:scale-90 disabled:opacity-40">
                <ImageSquare size={19} />
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void pickFile(e.target.files?.[0])} />
            </>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={withRef ? t(kind === "video" ? "cw.aichat.ph.videoRef" : "cw.aichat.ph.imageEdit") : kind ? t(`cw.aichat.ph.${kind}`) : t("cw.aichat.placeholder")}
            className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-5 outline-none"
          />
          <button
            type="button"
            aria-label={t("cw.aichat.send")}
            disabled={!input.trim() || busy || !store}
            onClick={() => void send()}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition active:scale-90 disabled:opacity-35"
          >
            <PaperPlaneRight size={18} weight="fill" />
          </button>
        </div>
      </div>

      <BottomSheet open={sheet === "models"} onClose={() => setSheet(null)}>
        {sheet === "models" &&
          (kind ? (
            <MediaModelSheet
              models={(media.data?.models ?? []).filter((m) => m.kind === kind && (!editing || EDIT_MODELS.includes(m.id)))}
              loading={media.isLoading}
              current={mediaId ?? undefined}
              opts={store?.opts ?? {}}
              note={editing ? t("cw.aichat.editOnly") : undefined}
              onPick={(id) => {
                update((s) => ({ ...s, picks: { ...s.picks, [editing ? "edit" : kind]: id } }));
                setSheet(null);
              }}
            />
          ) : (
            <ModelSheet
              models={models.data ?? []}
              loading={models.isLoading}
              current={store?.model}
              onPick={(id) => {
                update((s) => ({ ...s, model: id }));
                setSheet(null);
              }}
            />
          ))}
      </BottomSheet>

      <BottomSheet open={sheet === "voices"} onClose={() => setSheet(null)}>
        {sheet === "voices" && (
          <VoiceSheet
            voices={media.data?.voices ?? []}
            current={store?.opts.voice ?? "sarah"}
            onPick={(id) => {
              update((s) => ({ ...s, opts: { ...s.opts, voice: id } }));
              setSheet(null);
            }}
          />
        )}
      </BottomSheet>

      <BottomSheet open={sheet === "settings"} onClose={() => setSheet(null)}>
        <div className="mb-1 text-center text-[17px] font-semibold">{t("cw.aichat.settings")}</div>
        <div className="mt-3 text-[14px] font-semibold">{t("cw.aichat.capTitle")}</div>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t("cw.aichat.capDesc")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {CAPS.map((c) => (
            <button
              key={c.toString()}
              type="button"
              onClick={() => update((s) => ({ ...s, autoCap: c.toString() }))}
              className={cn("h-9 rounded-xl px-3 text-[13px] font-semibold transition active:scale-95", c === cap ? "bg-foreground text-background" : "bg-muted")}
            >
              {c === 0n ? t("cw.aichat.autoPayOff") : `≤ ${usd6(c)}`}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!count}
          onClick={() => {
            update((s) => ({ ...s, messages: [] }));
            setSheet(null);
            toast.success(t("cw.aichat.cleared"));
          }}
          className="mt-5 flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-muted text-[14px] font-semibold text-down disabled:opacity-40"
        >
          <Trash size={16} />
          {t("cw.aichat.clear")}
        </button>
        <p className="mt-4 text-center text-[11px] leading-4 text-muted-foreground">
          {t("cw.aichat.poweredBy")}
          <br />
          {t("cw.aichat.risk")}
        </p>
      </BottomSheet>

      <BottomSheet open={!!ask} onClose={() => answer(false)}>
        {ask && (
          <div>
            <div className="text-center text-[15px] text-muted-foreground">{kind ? t("cw.aichat.confirmTitleGen") : t("cw.aichat.confirmTitle")}</div>
            <div className="mt-1 text-center font-mono text-[34px] font-semibold tracking-tight">
              {usd6(ask.amount)} <span className="text-[16px] text-muted-foreground">USDC</span>
            </div>
            <div className="mt-1 text-center text-[12px] text-muted-foreground">
              {current.name} · {t("cw.aichat.balance", { v: usdcText(usdc.data) })}
            </div>
            <p className="mt-4 rounded-2xl bg-muted px-4 py-3 text-[12px] leading-5 text-muted-foreground">{kind ? t("cw.aichat.confirmDescGen") : t("cw.aichat.confirmDesc", { n: AI_MAX_TOKENS })}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => answer(false)} className="h-14 rounded-2xl bg-muted text-[16px] font-semibold">
                {t("common.cancel")}
              </button>
              <PrimaryButton onClick={() => answer(true)}>{t("cw.aichat.pay")}</PrimaryButton>
            </div>
          </div>
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

function Intro({ n, mode, onPick }: { n?: number; mode: Mode; onPick: (key: string) => void }) {
  return (
    <>
      <section className="relative overflow-hidden rounded-[26px] p-5 text-white shadow-[0_18px_40px_-20px_rgba(60,20,160,0.7)]" style={{ background: "linear-gradient(145deg, #1b0f5c 0%, #4b2bd6 55%, #0052ff 100%)" }}>
        <div className="pointer-events-none absolute -top-16 -right-12 size-48 rounded-full" style={{ background: "radial-gradient(circle, rgba(255,255,255,0.25), transparent 65%)" }} />
        <div className="relative flex items-center gap-2 text-[17px] font-semibold">
          <Sparkle size={20} weight="fill" />
          {t("cw.aichat.heroTitle")}
        </div>
        <ul className="relative mt-3 space-y-2 text-[13px] leading-5" style={{ color: "rgba(255,255,255,0.85)" }}>
          <li>· {t("cw.aichat.hero1", { n: n ?? 80 })}</li>
          <li>· {t("cw.aichat.hero2")}</li>
          <li>· {t("cw.aichat.hero3")}</li>
        </ul>
      </section>
      <div className="px-1 pt-1 text-[12px] font-medium text-muted-foreground">{t("cw.aichat.try")}</div>
      <div className="flex flex-col items-start gap-2">
        {EXAMPLES[mode].map((k) => (
          <button key={k} type="button" onClick={() => onPick(k)} className="rounded-2xl bg-card px-3.5 py-2 text-left text-[13px] ring-1 ring-border/60 transition active:scale-[0.98]">
            {t(k)}
          </button>
        ))}
      </div>
    </>
  );
}

function Bubble({ m, onUse }: { m: ChatMsg; onUse: (url: string, as: "image" | "video") => void }) {
  if (m.role === "user") {
    return (
      <div className="flex flex-col items-end">
        {m.kind && <KindTag kind={m.kind} refImg={m.ref} />}
        <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-primary px-4 py-2.5 text-[15px] leading-6 break-words whitespace-pre-wrap text-primary-foreground">{m.content}</div>
      </div>
    );
  }
  if (m.kind && !m.error) return <MediaBubble m={m} onUse={onUse} />;
  const paid = m.cost && m.cost !== "0";
  return (
    <div className="flex flex-col items-start">
      <div className={cn("max-w-[92%] rounded-[20px] rounded-bl-md px-4 py-2.5 text-[15px] leading-6 break-words whitespace-pre-wrap ring-1", m.error ? "bg-card text-down ring-border/60" : "bg-card ring-border/60")}>{m.content}</div>
      {!m.error && (
        <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <span className="max-w-[160px] truncate">{m.model}</span>·
          <span className={cn("font-mono", !paid && "text-up")}>{paid ? t("cw.aichat.paid", { v: usd6(m.cost!) }) : t("cw.aichat.free")}</span>
          {m.tx && (
            <a href={explorerTx(AI_CHAIN, m.tx)} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 underline-offset-2 hover:underline">
              {t("cw.aichat.viewTx")}
              <ArrowSquareOut size={11} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

const OWNER_COLORS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  google: "#4285f4",
  deepseek: "#4d6bfe",
  qwen: "#615ced",
  moonshot: "#16191e",
  xai: "#111111",
  zai: "#2d5bff",
  minimax: "#e8414e",
  nvidia: "#76b900",
  xiaomi: "#ff6900",
  tencent: "#0052d9",
};

function ModelMark({ owner, size }: { owner: string; size: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full font-bold text-white uppercase" style={{ width: size, height: size, fontSize: size * 0.42, background: OWNER_COLORS[owner] ?? "#6b7280" }}>
      {owner[0]}
    </span>
  );
}

function ModelSheet({ models, loading, current, onPick }: { models: AiModel[]; loading: boolean; current?: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const hit = (m: AiModel) => !s || m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s);
    const list = models.filter(hit);
    const featured = FEATURED.flatMap((id) => list.filter((m) => m.id === id));
    const free = list.filter((m) => m.free);
    const rest = list.filter((m) => !m.free).sort((a, b) => a.owner.localeCompare(b.owner) || a.input - b.input);
    return s ? [{ key: "all", items: list }] : [
      { key: "featured", items: featured },
      { key: "free", items: free },
      { key: "all", items: rest },
    ];
  }, [models, q]);
  const label: Record<string, string> = { featured: "cw.aichat.featured", free: "cw.aichat.freeModels", all: "cw.aichat.allModels" };
  return (
    <div>
      <div className="mb-3 text-center text-[17px] font-semibold">{t("cw.aichat.pickModel")}</div>
      <label className="flex h-11 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.aichat.search")} className="flex-1 bg-transparent text-[14px] outline-none" />
      </label>
      {loading && <div className="py-10 text-center text-[13px] text-muted-foreground">…</div>}
      {groups.map((g) =>
        g.items.length ? (
          <section key={g.key} className="mt-4">
            <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">{t(label[g.key])}</div>
            <ul>
              {g.items.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => onPick(m.id)} className="flex w-full items-center gap-3 rounded-2xl px-1 py-2.5 text-left transition active:bg-muted">
                    <ModelMark owner={m.owner} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[14px] font-semibold">
                        <span className="truncate">{m.name}</span>
                        {m.free && (
                          <span className="shrink-0 rounded px-1.5 text-[10px] font-semibold text-up" style={{ background: "rgba(22,163,74,0.12)" }}>
                            {t("cw.aichat.free")}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {m.owner} · {priceLabel(m)}
                      </span>
                    </span>
                    {m.id === current && <CheckCircle size={18} weight="fill" className="shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
