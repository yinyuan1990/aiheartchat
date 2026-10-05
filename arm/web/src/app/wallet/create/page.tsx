"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, Circle, EyeSlash, HandPalm, Prohibit, ShieldWarning, Sparkle } from "@phosphor-icons/react";
import { toast } from "sonner";
import { newMnemonic } from "@/lib/wallet/vault";
import { setSecureScreen } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
import { cn } from "@/lib/utils";
import { useVault } from "@/components/wallet/wallet-context";
import { Field, PasswordFields, passwordsOk } from "@/components/wallet/password-fields";
import { PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

type Step = "setup" | "pledge" | "show" | "verify" | "done";
const STEPS: Step[] = ["setup", "pledge", "show", "verify", "done"];

const PLEDGES = ["cw.create.pledge1", "cw.create.pledge2", "cw.create.pledge3"];

export default function CreateWalletPage() {
  const { status, wallets, addSecret } = useVault();
  const router = useRouter();
  const firstWallet = status === "empty";
  const [step, setStep] = useState<Step>("setup");
  const [name, setName] = useState(firstWallet ? t("cw.create.defaultName") : t("cw.create.nameN", { n: wallets.length + 1 }));
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [phrase] = useState(newMnemonic);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSecureScreen(step === "show" || step === "verify");
    return () => setSecureScreen(false);
  }, [step]);

  const back = STEPS.indexOf(step) > 0 && step !== "done" ? () => setStep(STEPS[STEPS.indexOf(step) - 1]) : undefined;

  const finish = async () => {
    setBusy(true);
    try {
      await addSecret(name.trim() || t("cw.create.defaultName"), { kind: "mnemonic", phrase }, firstWallet ? pw : undefined);
      setStep("done");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WalletFrame>
      <TopBar back={step === "setup" ? (firstWallet ? "/wallet/welcome" : "/wallet") : undefined} onBack={back} title={step === "done" ? "" : t("cw.create.title")} />
      {step !== "done" && (
        <div className="flex gap-1.5 px-4">
          {STEPS.slice(0, 4).map((s, i) => (
            <span key={s} className={cn("h-1 flex-1 rounded-full transition", i <= STEPS.indexOf(step) ? "bg-foreground" : "bg-muted")} />
          ))}
        </div>
      )}

      <div className="flex flex-1 flex-col px-4 pt-6">
        {step === "setup" && (
          <>
            <h1 className="text-[24px] font-semibold">{firstWallet ? t("cw.create.setupTitle") : t("cw.create.newTitle")}</h1>
            <p className="mt-1 text-[14px] text-muted-foreground">{firstWallet ? t("cw.create.setupDesc") : t("cw.create.reusePw")}</p>
            <div className="mt-6 space-y-4">
              <Field label={t("cw.create.nameLabel")}>
                <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} className="flex-1 bg-transparent text-[16px] outline-none" />
              </Field>
              {firstWallet && <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />}
            </div>
            <Footer>
              <PrimaryButton disabled={!name.trim() || (firstWallet && !passwordsOk(pw, pw2))} onClick={() => setStep("pledge")}>
                {t("common.next")}
              </PrimaryButton>
            </Footer>
          </>
        )}

        {step === "pledge" && <Pledge onNext={() => setStep("show")} />}
        {step === "show" && <ShowPhrase phrase={phrase} onNext={() => setStep("verify")} />}
        {step === "verify" && <VerifyPhrase phrase={phrase} busy={busy} onDone={finish} />}

        {step === "done" && (
          <div className="flex flex-1 flex-col items-center pt-16 text-center">
            <span className="flex size-24 animate-in items-center justify-center rounded-full bg-up/12 text-up duration-500 zoom-in-50">
              <CheckCircle size={56} weight="fill" />
            </span>
            <h1 className="mt-6 text-[24px] font-semibold">{t("cw.create.ready")}</h1>
            <p className="mt-2 max-w-[280px] text-[14px] leading-6 text-muted-foreground">{t("cw.create.readyDesc")}</p>
            <Footer>
              <PrimaryButton onClick={() => router.replace("/wallet")}>{t("cw.create.enter")}</PrimaryButton>
            </Footer>
          </div>
        )}
      </div>
    </WalletFrame>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto w-full pt-8 pb-[max(20px,env(safe-area-inset-bottom))]">{children}</div>;
}

function Pledge({ onNext }: { onNext: () => void }) {
  const [ok, setOk] = useState<boolean[]>(PLEDGES.map(() => false));
  return (
    <>
      <span className="flex size-14 items-center justify-center rounded-2xl bg-[#f5a524]/15 text-[#d48806]">
        <ShieldWarning size={30} weight="fill" />
      </span>
      <h1 className="mt-4 text-[24px] font-semibold">{t("cw.create.pledgeTitle")}</h1>
      <p className="mt-1 text-[14px] text-muted-foreground">{t("cw.create.pledgeDesc")}</p>
      <ul className="mt-6 space-y-2">
        {PLEDGES.map((p, i) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => setOk((v) => v.map((x, j) => (j === i ? !x : x)))}
              className={cn("flex w-full items-start gap-3 rounded-2xl p-4 text-left ring-1 transition active:scale-[0.99]", ok[i] ? "bg-up/8 ring-up/40" : "bg-card ring-border")}
            >
              {ok[i] ? <CheckCircle size={22} weight="fill" className="mt-0.5 shrink-0 text-up" /> : <Circle size={22} className="mt-0.5 shrink-0 text-muted-foreground" />}
              <span className="text-[14px] leading-6">{t(p)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Footer>
        <PrimaryButton disabled={!ok.every(Boolean)} onClick={onNext}>
          {t("cw.create.pledgeOk")}
        </PrimaryButton>
      </Footer>
    </>
  );
}

function ShowPhrase({ phrase, onNext }: { phrase: string; onNext: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const words = phrase.split(" ");
  return (
    <>
      <h1 className="text-[24px] font-semibold">{t("cw.create.showTitle")}</h1>
      <p className="mt-1 text-[14px] text-muted-foreground">{t("cw.create.showDesc")}</p>
      <div className="relative mt-6">
        <ol className={cn("grid grid-cols-3 gap-2 transition", !revealed && "pointer-events-none blur-md select-none")}>
          {words.map((w, i) => (
            <li key={i} className="flex h-12 items-center gap-2 rounded-xl bg-card px-3 ring-1 ring-border">
              <span className="w-5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              <span className="font-mono text-[15px] font-medium">{w}</span>
            </li>
          ))}
        </ol>
        {!revealed && (
          <button type="button" onClick={() => setRevealed(true)} className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-background/40 text-[14px] font-medium">
            <EyeSlash size={28} />
            {t("cw.create.tapReveal")}
            <span className="text-[12px] font-normal text-muted-foreground">{t("cw.create.revealHint")}</span>
          </button>
        )}
      </div>
      <ul className="mt-6 space-y-2 text-[13px] text-muted-foreground">
        <li className="flex gap-2"><HandPalm size={16} className="mt-0.5 shrink-0" />{t("cw.create.tipHandwrite")}</li>
        <li className="flex gap-2"><Prohibit size={16} className="mt-0.5 shrink-0" />{t("cw.create.tipNoCloud")}</li>
      </ul>
      <Footer>
        <PrimaryButton disabled={!revealed} onClick={onNext}>
          {t("cw.create.written")}
        </PrimaryButton>
      </Footer>
    </>
  );
}

/** Three random positions, six candidate words each (the right one + five others from the same phrase). */
function VerifyPhrase({ phrase, busy, onDone }: { phrase: string; busy: boolean; onDone: () => void }) {
  const words = useMemo(() => phrase.split(" "), [phrase]);
  const [quiz] = useState(() => {
    const idx = shuffle([...words.keys()]).slice(0, 3).sort((a, b) => a - b);
    return idx.map((i) => ({ i, options: shuffle([words[i], ...shuffle(words.filter((_, j) => j !== i)).slice(0, 5)]) }));
  });
  const [picked, setPicked] = useState<(string | null)[]>([null, null, null]);
  const [wrong, setWrong] = useState<number | null>(null);
  const allRight = quiz.every((q, k) => picked[k] === words[q.i]);

  return (
    <>
      <h1 className="text-[24px] font-semibold">{t("cw.create.verifyTitle")}</h1>
      <p className="mt-1 text-[14px] text-muted-foreground">{t("cw.create.verifyDesc")}</p>
      <div className="mt-6 space-y-5">
        {quiz.map((q, k) => (
          <div key={q.i}>
            <div className="text-[13px] font-medium text-muted-foreground">{t("cw.create.wordN", { n: q.i + 1 })}</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {q.options.map((w) => {
                const on = picked[k] === w;
                const bad = on && wrong === k;
                return (
                  <button
                    key={w}
                    type="button"
                    onClick={() => {
                      setPicked((p) => p.map((x, j) => (j === k ? w : x)));
                      setWrong(w === words[q.i] ? null : k);
                    }}
                    className={cn(
                      "h-11 rounded-xl font-mono text-[14px] font-medium ring-1 transition active:scale-95",
                      bad ? "bg-down/10 text-down ring-down" : on ? "bg-foreground text-background ring-foreground" : "bg-card ring-border",
                    )}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {wrong !== null && <p className="mt-3 text-[13px] text-down">{t("cw.create.wrongWord")}</p>}
      <Footer>
        <PrimaryButton disabled={!allRight || busy} onClick={onDone}>
          <span className="flex items-center justify-center gap-1.5">
            <Sparkle size={18} weight="fill" />
            {busy ? t("cw.create.saving") : t("common.done")}
          </span>
        </PrimaryButton>
      </Footer>
    </>
  );
}

function shuffle<T>(a: T[]): T[] {
  const r = crypto.getRandomValues(new Uint32Array(a.length));
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
