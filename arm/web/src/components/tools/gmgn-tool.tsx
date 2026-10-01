"use client";

import { useState } from "react";
import { BadgeDollarSign, CandlestickChart, ExternalLink, Info, Radar, Wallet } from "lucide-react";
import { isAddress } from "viem";
import { useApp } from "@/components/providers";
import { gmgnHomeUrl, gmgnTokenUrl, gmgnWalletUrl } from "@/lib/web3";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const go = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

export function GmgnTool() {
  const { t } = useApp();
  const [addr, setAddr] = useState("");
  const value = addr.trim();
  const ok = isAddress(value);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <Button size="xl" variant="glow" className="w-full" asChild>
            <a href={gmgnHomeUrl} target="_blank" rel="noreferrer"><CandlestickChart /> {t("gmgn.open")} <ExternalLink className="size-3.5" /></a>
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={t("gmgn.input")} className="font-mono" spellCheck={false} autoComplete="off" />
            <div className="flex gap-2">
              <Button variant="outline" disabled={!ok} className="flex-1 sm:flex-none" onClick={() => go(gmgnTokenUrl(value))}><CandlestickChart /> {t("gmgn.viewToken")}</Button>
              <Button variant="outline" disabled={!ok} className="flex-1 sm:flex-none" onClick={() => go(gmgnWalletUrl(value))}><Wallet /> {t("gmgn.viewWallet")}</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4 text-sm">
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 font-semibold"><CandlestickChart className="size-4 text-primary" /> {t("gmgn.what.title")}</h2>
            <ul className="list-disc space-y-1 pl-5 leading-relaxed text-muted-foreground">
              <li>{t("gmgn.what.1")}</li>
              <li>{t("gmgn.what.2")}</li>
              <li>{t("gmgn.what.3")}</li>
              <li>{t("gmgn.what.4")}</li>
            </ul>
          </section>
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 font-semibold"><Radar className="size-4 text-primary" /> {t("gmgn.how.title")}</h2>
            <ol className="list-decimal space-y-1 pl-5 leading-relaxed text-muted-foreground">
              <li>{t("gmgn.how.1")}</li>
              <li>{t("gmgn.how.2")}</li>
              <li>{t("gmgn.how.3")}</li>
            </ol>
          </section>
          <section className="space-y-2 rounded-xl border bg-muted/40 p-3">
            <h2 className="flex items-center gap-1.5 font-semibold"><BadgeDollarSign className="size-4 text-up" /> {t("gmgn.earn.title")}</h2>
            <p className="leading-relaxed text-muted-foreground">{t("gmgn.earn.body")}</p>
            <Button variant="outline" size="sm" asChild>
              <a href="https://gmgn.ai/referral?chain=sol" target="_blank" rel="noreferrer">{t("gmgn.earn.go")} <ExternalLink className="size-3" /></a>
            </Button>
          </section>
          <p className="flex gap-1.5 border-t pt-3 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" /> {t("gmgn.note")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
