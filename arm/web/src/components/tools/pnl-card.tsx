"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, Download, Loader2, Sparkles, Wallet } from "lucide-react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { useApp } from "@/components/providers";
import { useCard, type CardView } from "@/lib/api";
import { refLink } from "@/lib/referral";
import type { DictKey } from "@/lib/i18n";
import { holdTime, shortWallet, signedPct, signedUsd, usdShort } from "@/app/card/card-format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const XIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

export function PnlCard({ initial = "" }: { initial?: string }) {
  const { t, address, connected, toggleConnect } = useApp();
  // without an address in the URL, the connected wallet is the default until the user types / picks another one
  const fallback = !initial && address ? address : "";
  const [typed, setInput] = useState<string | null>(initial || null);
  const [picked, setWallet] = useState(isAddress(initial) ? initial.toLowerCase() : "");
  const input = typed ?? fallback;
  const wallet = picked || fallback.toLowerCase();
  const q = useCard(wallet || undefined);
  const value = input.trim();
  const ok = isAddress(value);

  const s = q.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (ok) setWallet(value.toLowerCase()); }}>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("card.input")} className="font-mono" spellCheck={false} autoComplete="off" />
            <Button type="submit" disabled={!ok || (q.isFetching && wallet === value.toLowerCase())} className="shrink-0">
              {q.isFetching && wallet === value.toLowerCase() ? <Loader2 className="animate-spin" /> : <Sparkles />} {t("card.go")}
            </Button>
          </form>
          <div className="flex items-center justify-between text-xs">
            {value && !ok ? <span className="text-down">{t("card.bad")}</span> : <span />}
            {connected && address ? (
              address.toLowerCase() !== value.toLowerCase() && (
                <button type="button" className="text-primary hover:underline" onClick={() => { setInput(address); setWallet(address.toLowerCase()); }}>{t("card.mine")}</button>
              )
            ) : (
              <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={toggleConnect}><Wallet className="size-3" /> {t("common.connect")}</button>
            )}
          </div>
        </CardContent>
      </Card>

      {wallet && q.isLoading && <div className="aspect-[40/21] w-full animate-pulse rounded-xl border bg-muted" />}
      {s?.status === "syncing" && (
        <Card><CardContent className="space-y-2 p-4 text-sm">
          <div className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> {t("card.syncing").replace("{n}", String(Math.floor(s.progress * 100)))}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.max(3, s.progress * 100)}%` }} /></div>
        </CardContent></Card>
      )}
      {s?.status === "error" && <Card><CardContent className="p-4 text-sm text-down">{t("card.contract")}</CardContent></Card>}
      {s?.status === "ready" && (s.card.trades > 0 ? <Result card={s.card} /> : <Card><CardContent className="p-4 text-sm text-muted-foreground">{t("card.empty")}</CardContent></Card>)}

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("card.how")}</p>
    </div>
  );
}

function Result({ card }: { card: CardView }) {
  const { t, locale, address } = useApp();
  const wallet = card.address.toLowerCase();
  const img = `/card/${wallet}/image?v=${encodeURIComponent(card.updatedAt)}`;
  const share = refLink(address ?? wallet, `/card/${wallet}`);
  const up = card.pnl >= 0;
  const persona = t(`persona.${card.persona}` as DictKey);
  const tweet = t("card.tweet")
    .replace("{pnl}", signedUsd(card.pnl)).replace("{pct}", signedPct(card.pct))
    .replace("{win}", `${Math.round(card.winRate * 100)}%`).replace("{p}", persona);
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(share)}`;
  const stats: [string, string, string?][] = [
    [t("card.pnl"), `${signedUsd(card.pnl)} (${signedPct(card.pct)})`, up ? "text-up" : "text-down"],
    [t("card.winRate"), `${Math.round(card.winRate * 100)}%  ${card.wins}/${card.wins + card.losses}`],
    [t("card.coins"), String(card.tokens)],
    [t("card.trades"), `${card.trades}`],
    [t("card.spent"), usdShort(card.spent)],
    [t("card.hold"), holdTime(card.avgHoldSec)],
  ];

  return (
    <div className="space-y-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt={`${shortWallet(card.address)} PnL card`} width={1200} height={630} className="aspect-[40/21] w-full rounded-xl border bg-black" />

      <div className="flex flex-wrap gap-2">
        <Button asChild><a href={intent} target="_blank" rel="noreferrer"><XIcon /> {t("card.share")}</a></Button>
        <Button variant="outline" asChild><a href={img} download={`arm-card-${wallet.slice(2, 8)}.png`}><Download /> {t("card.download")}</a></Button>
        <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(share).catch(() => {}); toast.success(t("common.copied")); }}><Copy /> {t("card.copy")}</Button>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4 text-sm">
          <div>
            <div className="text-lg font-semibold">{persona}</div>
            <div className="text-muted-foreground">{t(`persona.${card.persona}.d` as DictKey)}</div>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {stats.map(([k, v, c]) => (
              <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className={`font-mono ${c ?? ""}`}>{v}</dd></div>
            ))}
          </dl>
          {card.firstTradeAt && <div className="text-xs text-muted-foreground">{t("card.since")} · {new Date(card.firstTradeAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 text-sm">
          <div className="border-b px-4 py-2.5 font-medium">{t("card.table")}</div>
          <table className="w-full">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="px-4 py-2 text-left font-normal">{t("card.col.coin")}</th><th className="px-2 py-2 text-right font-normal">{t("card.col.spent")}</th><th className="px-2 py-2 text-right font-normal">{t("card.col.back")}</th><th className="px-4 py-2 text-right font-normal">PnL</th></tr>
            </thead>
            <tbody>
              {card.top.map((r) => (
                <tr key={r.address} className="border-t">
                  <td className="px-4 py-2"><Link href={`/tools?tab=holders&token=${r.address}`} className="font-medium hover:underline">{r.symbol}</Link>{r.address === card.best?.address && card.best.rank ? <span className="ml-1.5 text-[11px] text-muted-foreground">{t("card.rank").replace("{n}", String(card.best.rank))}</span> : null}</td>
                  <td className="px-2 py-2 text-right font-mono">{usdShort(r.spent)}</td>
                  <td className="px-2 py-2 text-right font-mono">{usdShort(r.received + r.holding)}</td>
                  <td className={`px-4 py-2 text-right font-mono ${r.pnl >= 0 ? "text-up" : "text-down"}`}>{signedPct(r.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
