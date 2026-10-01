"use client";

import { Bot, Copy, ExternalLink, Info, Rocket, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { EXCHANGES, NOFX_DOCKER, NOFX_REPO } from "@/lib/partners";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AiArena } from "./ai-arena";

export function AiTrade() {
  const { t } = useApp();
  const copy = async () => {
    await navigator.clipboard.writeText(NOFX_DOCKER).catch(() => {});
    toast.success(t("common.copied"));
  };

  return (
    <div className="space-y-4">
      <AiArena />
      <Card>
        <CardContent className="space-y-4 p-4 text-sm">
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 font-semibold"><Bot className="size-4 text-primary" /> {t("nofx.what.title")}</h2>
            <p className="leading-relaxed text-muted-foreground">{t("nofx.what.body")}</p>
          </section>
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 font-semibold"><ShieldCheck className="size-4 text-up" /> {t("nofx.risk.title")}</h2>
            <ul className="list-disc space-y-1 pl-5 leading-relaxed text-muted-foreground">
              <li>{t("nofx.risk.1")}</li>
              <li>{t("nofx.risk.2")}</li>
              <li>{t("nofx.risk.3")}</li>
            </ul>
          </section>
          <Button variant="outline" className="w-full" asChild>
            <a href={NOFX_REPO} target="_blank" rel="noreferrer">{t("nofx.repo")} <ExternalLink className="size-3.5" /></a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold"><Rocket className="size-4 text-primary" /> {t("nofx.setup.title")}</h2>
          <ol className="list-decimal space-y-1 pl-5 leading-relaxed text-muted-foreground">
            <li>{t("nofx.setup.1")}</li>
            <li>{t("nofx.setup.2")}</li>
            <li>{t("nofx.setup.3")}</li>
          </ol>
          <div className="relative rounded-xl border bg-muted/40 p-3 pr-12">
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre">{NOFX_DOCKER}</pre>
            <Button variant="ghost" size="sm" className="absolute top-1.5 right-1.5 size-8 p-0" onClick={copy} title={t("nofx.copy")} aria-label={t("nofx.copy")}><Copy /></Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="font-semibold">{t("nofx.ex.title")}</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EXCHANGES.map((e) => (
              <a key={e.name} href={e.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 transition hover:bg-muted/60">
                <span>
                  <span className="block font-medium">{e.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{t(e.note === "dex" ? "nofx.ex.dex" : "nofx.ex.cex")}</span>
                </span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-down/30">
        <CardContent className="space-y-2 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold"><ShieldAlert className="size-4 text-down" /> {t("nofx.warn.title")}</h2>
          <ul className="list-disc space-y-1 pl-5 leading-relaxed text-muted-foreground">
            <li>{t("nofx.warn.1")}</li>
            <li>{t("nofx.warn.2")}</li>
            <li>{t("nofx.warn.3")}</li>
            <li>{t("nofx.warn.4")}</li>
          </ul>
          <p className="flex gap-1.5 border-t pt-3 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" /> {t("nofx.note")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
