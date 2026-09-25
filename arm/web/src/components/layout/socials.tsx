"use client";

import { toast } from "sonner";
import { TG_HANDLE, TG_URL, X_HANDLE, X_URL } from "@/lib/site";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";

/** The X brand mark (same glyph pons uses in its footer), boxed. */
export function XMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Telegram paper plane (brand glyph, monochrome). */
export function TelegramMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M21.94 3.2a1.5 1.5 0 0 0-1.6-.24L2.5 10.4c-1.2.5-1.17 1.7.06 2.06l4.6 1.44 1.76 5.58c.21.6.4.85.86.85.44 0 .64-.2 1.04-.6l2.36-2.3 4.9 3.62c.9.5 1.56.24 1.78-.84l3.24-15.3c.32-1.32-.5-1.9-1.16-1.71ZM9.4 13.6l8.7-5.5c.42-.26.8-.12.49.17l-7.2 6.5-.28 3-1.71-4.17Z" />
    </svg>
  );
}

/** `copy`: the handle text copies itself (X — people paste it into the app's search); otherwise it links out too. */
function SocialItem({ href, label, handle, icon, copy: copyable }: { href: string; label: string; handle: string; icon: React.ReactNode; copy?: boolean }) {
  const { t } = useApp();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(handle);
      toast.success(t("common.copied"), { description: handle });
    } catch {}
  };
  const handleCls = "font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground";
  return (
    <span className="inline-flex items-center gap-1.5">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        title={`${label} · ${handle}`}
        className="inline-flex size-8 items-center justify-center rounded-md border border-foreground/15 text-foreground/80 transition-colors hover:border-primary/50 hover:text-foreground"
      >
        {icon}
      </a>
      {copyable ? (
        <button type="button" onClick={copy} title={t("common.copy")} className={handleCls}>{handle}</button>
      ) : (
        <a href={href} target="_blank" rel="noreferrer" title={label} className={handleCls}>{handle}</a>
      )}
    </span>
  );
}

/**
 * Official contact block: X and Telegram, each as a boxed brand mark linking out plus the copyable handle beside it.
 * Stacked by default (sidebar); `row` puts the two side by side for footers and settings cards.
 */
export function SocialLinks({ row, className }: { row?: boolean; className?: string }) {
  return (
    <div className={cn("flex gap-x-4 gap-y-2", row ? "flex-row flex-wrap items-center" : "flex-col items-start", className)}>
      <SocialItem href={X_URL} label="X" handle={`@${X_HANDLE}`} icon={<XMark size={14} />} copy />
      <SocialItem href={TG_URL} label="Telegram" handle={`@${TG_HANDLE}`} icon={<TelegramMark size={15} />} />
    </div>
  );
}
