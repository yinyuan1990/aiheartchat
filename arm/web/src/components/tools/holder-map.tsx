"use client";

import { useState } from "react";
import { CandlestickChart, ExternalLink, Info, Network, ScanSearch } from "lucide-react";
import { isAddress } from "viem";
import { useApp } from "@/components/providers";
import { bubblemapsUrl, gmgnTokenUrl } from "@/lib/web3";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function HolderMap({ initial = "" }: { initial?: string }) {
  const { t } = useApp();
  const [addr, setAddr] = useState(initial);
  const value = addr.trim();
  const ok = isAddress(value);

  const open = () => {
    if (ok) window.open(bubblemapsUrl(value), "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); open(); }}>
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={t("holders.input")} className="font-mono" spellCheck={false} autoComplete="off" />
            <Button type="submit" disabled={!ok} className="shrink-0">
              <ScanSearch /> {t("holders.open")}
            </Button>
            <Button type="button" variant="outline" disabled={!ok} className="shrink-0" title={t("gmgn.hint")} onClick={() => window.open(gmgnTokenUrl(value), "_blank", "noopener,noreferrer")}>
              <CandlestickChart /> GMGN
            </Button>
          </form>
          {value && !ok && <div className="text-xs text-down">{t("holders.bad")}</div>}
          <p className="flex gap-1.5 text-[11px] text-muted-foreground">
            <ExternalLink className="mt-0.5 size-3 shrink-0" /> {t("holders.newTab")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4 text-sm">
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 font-semibold"><Network className="size-4 text-primary" /> {t("holders.what.title")}</h2>
            <p className="leading-relaxed text-muted-foreground">{t("holders.what.body")}</p>
          </section>
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 font-semibold"><ScanSearch className="size-4 text-primary" /> {t("holders.read.title")}</h2>
            <ol className="list-decimal space-y-1 pl-5 leading-relaxed text-muted-foreground">
              <li>{t("holders.read.1")}</li>
              <li>{t("holders.read.2")}</li>
              <li>{t("holders.read.3")}</li>
              <li>{t("holders.read.4")}</li>
            </ol>
          </section>
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <p className="flex gap-1.5"><Info className="mt-0.5 size-3.5 shrink-0" /> {t("holders.note")}</p>
            <p>{t("holders.arm")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
