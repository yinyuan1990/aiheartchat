"use client";

import { useState } from "react";
import { ArrowLeftRight, Bug, Send } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { hotspotAdminMessage, postAdminTelegramTest, useAdminTelegram, useSite, type SiteFlags } from "@/lib/api";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errMsg } from "@/components/shared";
import { type Sign, signedCall } from "./hot-panel";

/** Site-wide switches, shown above the admin tabs. Each change is one owner-signed save (boss 9.13: the floating
 *  bug-report button must be switchable from the backend; 9.15: the /tools swap on/off + per-swap USD cap;
 *  9.17: Telegram buy bot — channel posts on/off, launch announcements, channel min-buy, test post).
 *  Read-only for non-owners. */
export function SitePanel({ canAct }: { canAct: boolean }) {
  const { t, address } = useApp();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const site = useSite();
  const tg = useAdminTelegram(true);
  const [busy, setBusy] = useState(false);
  const [capEdit, setCapEdit] = useState<string | null>(null); // null = show the saved value
  const [tgMinEdit, setTgMinEdit] = useState<string | null>(null);
  const cap = capEdit ?? (site.data ? String(site.data.swapMaxUsd) : "");
  const tgMin = tgMinEdit ?? (site.data ? String(site.data.tgChannelMinBuyUsd) : "");

  const save = async (patch: Partial<SiteFlags>) => {
    setBusy(true);
    try {
      await signedCall(signMessageAsync as Sign, address, "settings", "/settings", patch);
      toast.success(t("admin.hot.saved"));
      await qc.invalidateQueries({ queryKey: ["site"] });
      void qc.invalidateQueries({ queryKey: ["admin", "hotspots"] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const testTg = async () => {
    if (!address) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const signature = await signMessageAsync({ message: hotspotAdminMessage("telegram:test", ts, {}) });
      const r = await postAdminTelegramTest({ author: address, ts, signature, payload: {} });
      if (r.ok) toast.success("Telegram OK");
      else toast.error(r.error ?? "failed");
      void qc.invalidateQueries({ queryKey: ["admin", "telegram"] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const capNum = Number(cap);
  const capDirty = !!site.data && Number.isFinite(capNum) && capNum >= 0 && capNum !== site.data.swapMaxUsd;
  const tgMinNum = Number(tgMin);
  const tgMinDirty = !!site.data && Number.isFinite(tgMinNum) && tgMinNum >= 0 && tgMinNum !== site.data.tgChannelMinBuyUsd;
  const off = !canAct || busy || !site.data;
  const activeGroups = tg.data?.subscriptions.filter((s) => s.active).length ?? 0;

  return (
    <div className="space-y-2 rounded-xl border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="label">{t("admin.site.title")}</span>
        <label className="inline-flex items-center gap-2">
          <Switch id="site-bug" checked={site.data?.bugButton ?? true} disabled={off} onCheckedChange={(v) => void save({ bugButton: v })} />
          <Label htmlFor="site-bug" className="inline-flex items-center gap-1 text-xs"><Bug className="size-3.5" /> {t("admin.site.bugButton")}</Label>
        </label>
        <label className="inline-flex items-center gap-2">
          <Switch id="site-swap" checked={site.data?.swapEnabled ?? true} disabled={off} onCheckedChange={(v) => void save({ swapEnabled: v })} />
          <Label htmlFor="site-swap" className="inline-flex items-center gap-1 text-xs"><ArrowLeftRight className="size-3.5" /> {t("admin.site.swap")}</Label>
        </label>
        <label className="inline-flex items-center gap-2">
          <span>{t("admin.site.swapMax")}</span>
          <Input type="number" min={0} step={1} value={cap} disabled={off} onChange={(e) => setCapEdit(e.target.value)} className="h-7 w-24 font-mono text-xs" />
          {capDirty && (
            <Button size="sm" variant="gold" className="h-7 px-2 text-xs" disabled={off} onClick={() => void save({ swapMaxUsd: capNum }).then(() => setCapEdit(null))}>
              {t("common.save")}
            </Button>
          )}
        </label>
      </div>

      {/* Telegram buy bot */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-2">
        <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
          <Send className="size-3.5" />
          {tg.data?.bot ? `@${tg.data.bot}` : t("admin.site.tgNotSet")}
          {tg.data?.channel && <> · <a href={`https://t.me/${tg.data.channel}`} target="_blank" rel="noreferrer" className="hover:underline">@{tg.data.channel}</a></>}
          {tg.data && <> · {activeGroups} {t("admin.site.tgGroups")}</>}
        </span>
        <label className="inline-flex items-center gap-2">
          <Switch id="site-tg" checked={site.data?.tgEnabled ?? true} disabled={off} onCheckedChange={(v) => void save({ tgEnabled: v })} />
          <Label htmlFor="site-tg" className="text-xs">{t("admin.site.tg")}</Label>
        </label>
        <label className="inline-flex items-center gap-2">
          <Switch id="site-tg-launch" checked={site.data?.tgLaunches ?? true} disabled={off} onCheckedChange={(v) => void save({ tgLaunches: v })} />
          <Label htmlFor="site-tg-launch" className="text-xs">{t("admin.site.tgLaunches")}</Label>
        </label>
        <label className="inline-flex items-center gap-2">
          <Switch id="site-tg-photo" checked={site.data?.tgPhotos ?? false} disabled={off} onCheckedChange={(v) => void save({ tgPhotos: v })} />
          <Label htmlFor="site-tg-photo" className="text-xs">{t("admin.site.tgPhotos")}</Label>
        </label>
        <label className="inline-flex items-center gap-2">
          <span>{t("admin.site.tgMinBuy")}</span>
          <Input type="number" min={0} step={1} value={tgMin} disabled={off} onChange={(e) => setTgMinEdit(e.target.value)} className="h-7 w-24 font-mono text-xs" />
          {tgMinDirty && (
            <Button size="sm" variant="gold" className="h-7 px-2 text-xs" disabled={off} onClick={() => void save({ tgChannelMinBuyUsd: tgMinNum }).then(() => setTgMinEdit(null))}>
              {t("common.save")}
            </Button>
          )}
        </label>
        {tg.data?.configured && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={off || !tg.data.channelSet} onClick={() => void testTg()}>
            {t("admin.site.tgTest")}
          </Button>
        )}
        {tg.data?.lastError && <span className="text-destructive">{tg.data.lastError}</span>}
      </div>
    </div>
  );
}
