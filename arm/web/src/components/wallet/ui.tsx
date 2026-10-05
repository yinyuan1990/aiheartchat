"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { ArrowLeft, CaretDown, Compass, ChartLineUp, UserCircle, Wallet as WalletIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/wallet/i18n";
type ChainInfo = { name: string; color: string; glyph: string; icon?: string };

const noSubscribe = () => () => {};

/** A query-string value read on the client only (null during SSR); used to open a preview state straight from the URL. */
export function useQueryParam(key: string): string | null {
  return useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get(key), () => null);
}

/** Phone-width column; on desktop the wallet stays a centred phone-sized card. */
export function WalletFrame({ children, className, theme, style }: { children: React.ReactNode; className?: string; /** force a theme for this page ("terminal" = black) */ theme?: "terminal"; style?: React.CSSProperties }) {
  return (
    <div data-theme={theme} style={style} className="min-h-dvh bg-background text-foreground sm:bg-muted/60 sm:py-6">
      <div className={cn("relative mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-background sm:min-h-[860px] sm:overflow-hidden sm:rounded-[32px] sm:shadow-xl", className)}>
        {children}
      </div>
    </div>
  );
}

export function TopBar({ title, back, onBack, right }: { title?: React.ReactNode; back?: string; onBack?: () => void; right?: React.ReactNode }) {
  const cls = "flex size-10 items-center justify-center rounded-full transition active:scale-90 hover:bg-muted";
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 bg-background/85 px-3 backdrop-blur-xl">
      {onBack ? (
        <button type="button" aria-label={t("common.back")} onClick={onBack} className={cls}>
          <ArrowLeft size={20} weight="bold" />
        </button>
      ) : back ? (
        <Link href={back} aria-label={t("common.back")} className={cls}>
          <ArrowLeft size={20} weight="bold" />
        </Link>
      ) : (
        <span className="w-1" />
      )}
      <div className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</div>
      <div className="flex items-center gap-1">{right}</div>
    </header>
  );
}

export function IconButton({ children, label, onClick, className }: { children: React.ReactNode; label: string; onClick?: () => void; className?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={cn("flex size-10 items-center justify-center rounded-full text-foreground/80 transition active:scale-90 hover:bg-muted", className)}>
      {children}
    </button>
  );
}

export function ChainGlyph({ chain, size = 18 }: { chain: ChainInfo; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white ring-2 ring-background"
      style={{ width: size, height: size, fontSize: size * 0.55, background: chain.color }}
    >
      {chain.icon && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={chain.icon} alt={chain.name} width={size} height={size} className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        chain.glyph
      )}
    </span>
  );
}

export function ChainPill({ chain, onClick }: { chain: ChainInfo; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-muted pr-2.5 pl-1.5 text-[13px] font-medium whitespace-nowrap transition active:scale-95">
      <ChainGlyph chain={chain} size={22} />
      {chain.name}
      <CaretDown size={12} weight="bold" className="text-muted-foreground" />
    </button>
  );
}

/** Numbers in the mono face, with the small-price zero run shown as a real subscript ("0.0₄509" → 0.0<sub>4</sub>509). */
export function Num({ value, className }: { value: string; className?: string }) {
  const m = value.match(/^(.*?0\.0)([₀-₉]+)(.*)$/);
  if (!m) return <span className={cn("font-mono tabular-nums", className)}>{value}</span>;
  const sub = [...m[2]].map((c) => "₀₁₂₃₄₅₆₇₈₉".indexOf(c)).join("");
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {m[1]}
      <sub className="text-[0.62em]">{sub}</sub>
      {m[3]}
    </span>
  );
}

export function Pct({ value, className }: { value: number; className?: string }) {
  const s = `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}%`;
  return <span className={cn("font-mono text-[13px] tabular-nums", value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground", className)}>{s}</span>;
}

const NAV = [
  { href: "/wallet", label: "cw.ui.navAssets", icon: WalletIcon },
  { href: "/wallet/token", label: "cw.ui.navTrade", icon: ChartLineUp },
  { href: "/wallet/dapp", label: "cw.ui.navDapp", icon: Compass },
  { href: "/wallet/me", label: "tab.me", icon: UserCircle },
];

/** Pinned to the viewport on phones (sticky drifts away inside the App WebViews); the spacer keeps content clear of it. */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <>
      <div aria-hidden className="mt-auto h-[calc(80px+max(12px,env(safe-area-inset-bottom)))] shrink-0 sm:hidden" />
      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[430px] px-4 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] sm:sticky sm:mt-auto">
        <div className="flex h-16 items-center justify-around rounded-[22px] border border-border/60 bg-card/90 shadow-[0_8px_30px_rgba(0,0,0,0.08)] backdrop-blur-xl">
          {NAV.map((n) => {
            const active = n.href === "/wallet" ? pathname === "/wallet" : pathname.startsWith(n.href);
            const Icon = n.icon;
            return (
              <Link key={n.href} href={n.href} className={cn("flex w-16 flex-col items-center gap-0.5 text-[11px] transition active:scale-90", active ? "text-foreground" : "text-muted-foreground")}>
                <Icon size={24} weight={active ? "fill" : "regular"} />
                {t(n.label)}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

/** Bottom sheet scoped to the WalletFrame (absolute, so it stays phone-width on desktop). */
export function BottomSheet({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: React.ReactNode; className?: string }) {
  return (
    <div aria-hidden={!open} className={cn("fixed inset-0 z-40 sm:absolute", !open && "pointer-events-none")}>
      <button type="button" aria-label={t("common.close")} onClick={onClose} className={cn("absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200", open ? "opacity-100" : "opacity-0")} />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 max-h-[88%] overflow-y-auto rounded-t-[28px] bg-card px-5 pt-2 pb-[max(20px,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out",
          open && "shadow-[0_-10px_40px_rgba(0,0,0,0.18)]",
          className,
        )}
        // plain `transform`, not Tailwind's translate-* (the standalone `translate` property needs Chromium 104+)
        style={{ transform: open ? "translateY(0)" : "translateY(100%)" }}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        {children}
      </div>
    </div>
  );
}

export function PrimaryButton({ children, onClick, tone = "default", disabled, className }: { children: React.ReactNode; onClick?: () => void; tone?: "default" | "up" | "down" | "danger"; disabled?: boolean; className?: string }) {
  const tones = {
    default: "bg-primary text-primary-foreground",
    up: "bg-up text-white",
    down: "bg-down text-white",
    danger: "bg-down text-white",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn("h-14 w-full rounded-2xl text-[16px] font-semibold transition active:scale-[0.98] disabled:opacity-40", tones[tone], className)}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, disabled, className }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cn("flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold transition active:scale-[0.98] disabled:opacity-40", className)}>
      {children}
    </button>
  );
}
