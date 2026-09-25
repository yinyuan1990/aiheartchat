"use client";

import { useState, useSyncExternalStore } from "react";
import { Copy, Globe, Hash, MessageCircle, Send, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { shortAddr, timeAgo } from "@/lib/format";
import { clockStore, secondClockStore } from "@/lib/store";
import { useApp } from "@/components/providers";
import { Card, CardContent } from "@/components/ui/card";

type Socials = { website?: string; twitter?: string; telegram?: string; discord?: string; farcaster?: string };
const SOCIALS: { key: keyof Socials; label: string; Icon: typeof Globe }[] = [
  { key: "website", label: "Website", Icon: Globe },
  { key: "twitter", label: "X", Icon: X },
  { key: "telegram", label: "Telegram", Icon: Send },
  { key: "discord", label: "Discord", Icon: MessageCircle },
  { key: "farcaster", label: "Farcaster", Icon: Hash },
];

/** Compact icon row for a token's creator-supplied links; renders nothing when none are set. `stop` keeps clicks
 *  from bubbling into a wrapping card link. */
export function SocialIcons({ socials, size = 14, className, stop }: { socials: Socials; size?: number; className?: string; stop?: boolean }) {
  const items = SOCIALS.filter((s) => (socials[s.key] ?? "").trim().length > 0);
  if (items.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {items.map(({ key, label, Icon }) => (
        <a
          key={key}
          href={socials[key]}
          target="_blank"
          rel="noreferrer"
          title={label}
          aria-label={label}
          onClick={stop ? (e) => e.stopPropagation() : undefined}
          className="inline-flex size-6 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          <Icon size={size} />
        </a>
      ))}
    </span>
  );
}

/** KPI tile built on shadcn Card. */
export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down" | "primary" | "gold" | "burn";
  className?: string;
}) {
  const toneCls = tone ? { up: "text-up", down: "text-down", primary: "text-primary", gold: "text-gold", burn: "text-burn" }[tone] : "text-foreground";
  const accent = tone ? { up: "bg-up", down: "bg-down", primary: "bg-primary", gold: "bg-gold", burn: "bg-burn" }[tone] : "bg-foreground/15";
  return (
    <Card size="sm" className={cn("relative", className)}>
      <span className={cn("absolute top-3 bottom-3 left-0 w-0.5 rounded-r-full", accent)} />
      <CardContent>
        <div className="label">{label}</div>
        <div className={cn("mt-1 font-mono text-xl font-semibold tracking-tight tabular md:text-2xl", toneCls)}>{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** Deterministic hue from an address so fallbacks stay stable. */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 2; i < Math.min(seed.length, 14); i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** Token avatar: on-chain logo URL if it loads, otherwise a gradient tile with the symbol's first letters. */
export function TokenAvatar({ logo, symbol, seed, size = 40, fontScale, className }: { logo?: string; symbol: string; seed: string; size?: number; /** fallback glyph size as a fraction of `size` (default 0.36, emoji 0.5) */ fontScale?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const hue = hueOf(seed);
  // absolute URLs, or our host-relative paths (/api/uploads/x, /brand/x — served by whichever domain the user is on)
  const showImg = !!logo && /^(https?:\/\/|\/)/.test(logo) && !broken;
  // "emoji:🚀" is the no-upload path used by the create form.
  const emoji = logo?.startsWith("emoji:") ? logo.slice(6) : null;
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-bold text-white select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: size * (fontScale ?? (emoji ? 0.5 : 0.36)),
        background: showImg ? undefined : `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 40) % 360} 70% 30%))`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,.2)",
      }}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={symbol} width={size} height={size} className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        emoji ?? symbol.slice(0, 2).toUpperCase()
      )}
    </div>
  );
}

/** Small circular identicon for wallets. */
export function WalletDot({ address, size = 16, className }: { address: string; size?: number; className?: string }) {
  const h1 = hueOf(address);
  const h2 = (h1 + 90) % 360;
  return <span className={cn("inline-block shrink-0 rounded-full", className)} style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h1} 70% 50%), hsl(${h2} 70% 35%))` }} />;
}

export function TimeAgo({ ts, className }: { ts: number | string; className?: string }) {
  const now = useSyncExternalStore(clockStore.subscribe, clockStore.get, clockStore.getServer);
  const ms = typeof ts === "string" ? new Date(ts).getTime() : ts;
  return (
    <span className={cn("tabular", className)} suppressHydrationWarning>
      {now === null ? "…" : timeAgo(ms, now)}
    </span>
  );
}

/** Time until a unix-seconds deadline: "6d 22h" beyond a day, "12h05m" under it; ticks with the shared clock. */
export function Countdown({ eta, className }: { eta: number; className?: string }) {
  const clock = useSyncExternalStore(clockStore.subscribe, clockStore.get, clockStore.getServer);
  if (clock === null) return <span className={cn("font-mono", className)}>…</span>;
  const s = Math.max(0, Math.floor(eta - clock / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const text = d > 0 ? `${d}d ${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
  return <span className={cn("font-mono tabular", className)}>{text}</span>;
}

/** Live countdown ticking every second: "6d 22:17:05" beyond a day, "22:17:05" under it. */
export function LiveCountdown({ eta, className }: { eta: number; className?: string }) {
  const now = useSyncExternalStore(secondClockStore.subscribe, secondClockStore.get, secondClockStore.getServer);
  if (now === null) return <span className={cn("font-mono", className)}>…</span>;
  const s = Math.max(0, Math.floor(eta - now / 1000));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return (
    <span className={cn("font-mono tabular", className)}>
      {d > 0 && <>{d}d </>}
      {hh}:{mm}:{ss}
    </span>
  );
}

export function Addr({ value, head = 6, tail = 4, className }: { value: string; head?: number; tail?: number; className?: string }) {
  const { t } = useApp();
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(t("common.copied"), { description: value });
        } catch {}
      }}
      title={t("common.copy")}
      className={cn("inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground", className)}
    >
      {shortAddr(value, head, tail)}
      <Copy size={12} />
    </button>
  );
}

/** Tiny inline price chart (a filled step-ish line); colour follows the first→last direction. */
export function Sparkline({ data, width = 72, height = 26, className }: { data?: number[]; width?: number; height?: number; className?: string }) {
  const pts = (data ?? []).filter((v) => Number.isFinite(v));
  // a single quiet hour still draws a flat line instead of nothing
  const series = pts.length === 1 ? [pts[0], pts[0]] : pts;
  if (series.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || max || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (series.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = series.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${(pad + (series.length - 1) * stepX).toFixed(1)},${height - pad}`;
  const up = series[series.length - 1] >= series[0];
  const color = up ? "var(--up)" : "var(--down)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("shrink-0 overflow-visible", className)} aria-hidden>
      <polygon points={area} fill={color} opacity={0.15} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function PctChange({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cn("font-mono text-muted-foreground", className)}>—</span>;
  const up = value >= 0;
  return (
    <span className={cn("font-mono tabular", up ? "text-up" : "text-down", className)}>
      {up ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

export function SectionTitle({ children, right, className }: { children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-end justify-between gap-3", className)}>
      <h2 className="text-sm font-semibold md:text-base">{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-center py-8 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

/** Wraps a wagmi/viem error into a short toast-friendly message. */
export function errMsg(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string }) ?? {};
  const s = m.shortMessage ?? m.message ?? String(e);
  return s.split("\n")[0].slice(0, 160);
}
