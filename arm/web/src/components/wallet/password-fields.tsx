"use client";

import { useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { passwordProblem, passwordStrength } from "@/lib/wallet/vault";
import { cn } from "@/lib/utils";
import { t } from "@/lib/wallet/i18n";

export function Field({ label, children, hint, error }: { label: string; children: React.ReactNode; hint?: React.ReactNode; error?: string | null }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <div className={cn("mt-1.5 flex h-14 items-center rounded-2xl bg-card px-4 ring-1 transition", error ? "ring-down" : "ring-border focus-within:ring-foreground")}>{children}</div>
      {(error || hint) && <div className={cn("mt-1.5 px-1 text-[12px]", error ? "text-down" : "text-muted-foreground")}>{error || hint}</div>}
    </label>
  );
}

function Secret({ value, onChange, placeholder, autoComplete }: { value: string; onChange: (v: string) => void; placeholder: string; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete} className="min-w-0 flex-1 bg-transparent text-[16px] outline-none" />
      <button type="button" aria-label={show ? t("cw.pwd.hide") : t("cw.pwd.show")} onClick={() => setShow((v) => !v)} className="text-muted-foreground">
        {show ? <EyeSlash size={20} /> : <Eye size={20} />}
      </button>
    </>
  );
}

const STRENGTH = [
  { label: "cw.pwd.weak", cls: "bg-down", n: 1 },
  { label: "cw.pwd.medium", cls: "bg-[#f5a524]", n: 2 },
  { label: "cw.pwd.strong", cls: "bg-up", n: 3 },
];

/** Password + confirmation; reports a valid password through `onValid` (null while invalid). */
export function PasswordFields({ pw, setPw, pw2, setPw2 }: { pw: string; setPw: (v: string) => void; pw2: string; setPw2: (v: string) => void }) {
  const problem = pw ? passwordProblem(pw) : null;
  const s = STRENGTH[passwordStrength(pw)];
  const mismatch = pw2.length > 0 && pw2 !== pw;
  return (
    <div className="space-y-4">
      <Field
        label={t("cw.pwd.label")}
        error={problem}
        hint={
          pw ? (
            <span className="flex items-center gap-2">
              <span className="flex gap-1">
                {[1, 2, 3].map((i) => (
                  <span key={i} className={cn("h-1.5 w-6 rounded-full", i <= s.n ? s.cls : "bg-muted")} />
                ))}
              </span>
              {t("cw.pwd.strength", { level: t(s.label) })}
            </span>
          ) : (
            t("cw.pwd.hint")
          )
        }
      >
        <Secret value={pw} onChange={setPw} placeholder={t("cw.vault.minLength", { n: 8 })} autoComplete="new-password" />
      </Field>
      <Field label={t("cw.pwd.confirm")} error={mismatch ? t("cw.pwd.mismatch") : null}>
        <Secret value={pw2} onChange={setPw2} placeholder={t("cw.pwd.again")} autoComplete="new-password" />
      </Field>
    </div>
  );
}

export const passwordsOk = (pw: string, pw2: string) => !passwordProblem(pw) && pw === pw2;
