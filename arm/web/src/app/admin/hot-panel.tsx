"use client";

import { useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { hotspotAdminMessage, postHotspotAdmin, useAdminHotspots, type HotspotSettings } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, SectionTitle, Stat, TimeAgo, TokenAvatar, errMsg } from "@/components/shared";
import { CategoryBadge, PLATFORMS, SourceIcon, originLabel, sourceLabel, typeKey } from "@/components/hot/source";

export type Sign = (args: { message: string }) => Promise<`0x${string}`>;

/** Sign the admin message with the owner wallet and post it; the indexer re-derives the signer and checks owner(). */
export async function signedCall<T>(sign: Sign, address: string | undefined, action: string, path: string, payload: unknown) {
  if (!address) throw new Error("connect wallet");
  const ts = Date.now();
  const signature = await sign({ message: hotspotAdminMessage(action, ts, payload) });
  return postHotspotAdmin<T>(path, { author: address, ts, signature, payload });
}

/** Owner-signed settings + moderation for the AI Meme Radar. Read-only for everyone else. */
export function HotPanel({ canAct }: { canAct: boolean }) {
  const { t, locale, address } = useApp();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const { data } = useAdminHotspots(true);
  const [edits, setEdits] = useState<Partial<HotspotSettings>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const form: HotspotSettings | null = data ? { ...data.settings, ...edits, sources: { ...data.settings.sources, ...(edits.sources ?? {}) }, tax: { ...data.settings.tax, ...(edits.tax ?? {}) } } : null;
  const setForm = (next: HotspotSettings) => setEdits(next);

  const listPg = usePage(data?.items, 25);
  const signed = <T,>(action: string, path: string, payload: unknown) => signedCall<T>(signMessageAsync as Sign, address, action, path, payload);
  const refresh = () => {
    setEdits({});
    return qc.invalidateQueries({ queryKey: ["admin", "hotspots"] });
  };

  const save = async () => {
    if (!form) return;
    setBusy("save");
    try {
      await signed("settings", "/settings", form);
      toast.success(t("admin.hot.saved"));
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const act = async (id: number, action: "hide" | "show" | "regenerate") => {
    setBusy(`${id}:${action}`);
    try {
      await signed(`hotspot:${id}`, `/${id}`, { action });
      refresh();
      void qc.invalidateQueries({ queryKey: ["hotspots"] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const crawl = async () => {
    setBusy("crawl");
    try {
      await signed("refresh", "/refresh", {});
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (!data || !form) return <Empty>{t("common.noData")}</Empty>;
  const S = data.state;
  const num = (k: keyof HotspotSettings, v: string) => setForm({ ...form, [k]: Number(v) });
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const tickHint = t("admin.hot.lastTickHint").replace("{f}", String(S.last.fetched)).replace("{m}", String(S.last.merged)).replace("{b}", String(S.last.blocked)).replace("{a}", String(S.last.aiBatches)).replace("{ms}", String(S.last.ms));
  const xHint = t("admin.hot.xUsageHint").replace("{r}", String(S.x.requests)).replace("{s}", String(S.x.searches)).replace("{p}", String(S.x.posts)).replace("{n}", S.x.nextRegion).replace("{pace}", (S.x.paceUsd ?? 0).toFixed(2)) + (S.x.lastRoundStop ? ` · ${t("admin.hot.xRoundStop")} ${S.x.lastRoundStop}` : "");

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label={t("admin.hot.state")} value={data.settings.enabled ? "ON" : "OFF"} tone={data.settings.enabled ? "up" : "down"} sub={S.lastError ? <span className="text-down">{S.lastError}</span> : S.lastTick ? <><TimeAgo ts={S.lastTick} /> · {tickHint}</> : "—"} />
        <Stat label={t("admin.hot.gate")} value={`${data.gate.published} / ${data.gate.blocked} / ${data.gate.pending}`} sub={t("admin.hot.gateHint")} />
        <Stat label={t("admin.hot.xUsage")} value={`$${S.x.costUsd.toFixed(2)} / $${data.settings.xDailyBudgetUsd}`} tone={S.x.costUsd >= data.settings.xDailyBudgetUsd ? "down" : undefined} sub={S.x.breakoutError ? <span className="text-down">breakout: {S.x.breakoutError.slice(0, 80)}</span> : xHint} />
        <Stat label={t("admin.hot.generatedToday")} value={`${data.aiToday} / ${data.settings.aiDailyCap}`} />
        <Stat label={t("admin.hot.claims")} value={`${data.claims.day} / ${data.claims.launched}`} sub={`${t("hot.all")} ${data.claims.total}`} />
        <Stat label={t("admin.hot.aiPath")} value={data.ai.copy} tone={data.ai.copy !== "template" ? "up" : undefined} sub={`logo: ${data.ai.logo} · X ${data.ai.x ? "✓" : "✗"} · ${sourceLabel("weibo", locale)} ✓`} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardContent>
            <div className="label mb-2">{t("admin.hot.daily")}</div>
            <Table>
              <TableHeader><TableRow><TableHead>Day</TableHead><TableHead className="text-right">fetched</TableHead><TableHead className="text-right">merged</TableHead><TableHead className="text-right">blocked</TableHead><TableHead className="text-right">published</TableHead><TableHead className="text-right">X req</TableHead><TableHead className="text-right">X posts</TableHead><TableHead className="text-right">AI</TableHead></TableRow></TableHeader>
              <TableBody className="font-mono text-xs tabular">
                {data.daily.map((d) => (
                  <TableRow key={d.day}><TableCell>{String(d.day).slice(0, 10)}</TableCell><TableCell className="text-right">{d.fetched}</TableCell><TableCell className="text-right">{d.merged}</TableCell><TableCell className="text-right">{d.blocked}</TableCell><TableCell className="text-right">{d.published}</TableCell><TableCell className="text-right">{d.x_requests}</TableCell><TableCell className="text-right">{d.x_posts}</TableCell><TableCell className="text-right">{d.ai_calls}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent>
            <div className="label mb-2">{t("admin.hot.reasons")}</div>
            <div className="flex flex-wrap gap-1.5">
              {data.reasons.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
              {data.reasons.map((r) => <Badge key={r.reason ?? "?"} variant="secondary" className="font-mono">{r.reason ?? "?"} <span className="ml-1 tabular">{r.n}</span></Badge>)}
            </div>
            <div className="label mt-4 mb-2">{t("admin.hot.sources")}</div>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {Object.entries(S.sources).map(([k, v]) => <Badge key={k} variant={v.ok ? "outline" : "down"} className="font-mono">{k} {v.count} · <TimeAgo ts={v.at} /></Badge>)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle>{t("admin.hot.settings")}</SectionTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="hot-enabled" className="text-xs">{t("admin.hot.enabled")}</Label>
              <Switch id="hot-enabled" checked={form.enabled} disabled={!canAct} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label className="label">{t("admin.hot.sources")}</Label>
              <div className="flex flex-wrap gap-3">
                {PLATFORMS.map((s) => (
                  <label key={s} className="inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
                    <Switch checked={form.sources[s]} disabled={!canAct} onCheckedChange={(v) => setForm({ ...form, sources: { ...form.sources, [s]: v } })} />
                    <SourceIcon source={s} /> {sourceLabel(s, locale)}
                    {!data.ai[s] && <Badge variant="outline" className="text-[10px]">{t("admin.hot.keyMissing")}</Badge>}
                  </label>
                ))}
              </div>
            </div>
            <Field label={t("admin.hot.interval")}><Input type="number" min={1} value={Math.round(form.intervalMs / 60000)} disabled={!canAct} className="w-28 font-mono" onChange={(e) => setForm({ ...form, intervalMs: Number(e.target.value) * 60000 })} /></Field>
            <Field label={t("admin.hot.xRegions")}><Input value={form.xRegions.join(", ")} disabled={!canAct} className="font-mono uppercase" onChange={(e) => setForm({ ...form, xRegions: list(e.target.value).map((r) => r.toUpperCase()) })} /></Field>
            <Field label={t("admin.hot.xTrendInterval")}><Input type="number" min={10} value={Math.round(form.xTrendIntervalMs / 60000)} disabled={!canAct} className="w-28 font-mono" onChange={(e) => setForm({ ...form, xTrendIntervalMs: Number(e.target.value) * 60000 })} /></Field>
            <Field label={t("admin.hot.xRegionsPerTick")}><Input type="number" min={1} max={8} value={form.xRegionsPerTick} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("xRegionsPerTick", e.target.value)} /></Field>
            <Field label={t("admin.hot.xAccounts")} className="md:col-span-2">
              <Input value={form.xAccounts.join(", ")} disabled={!canAct} className="font-mono" onChange={(e) => setForm({ ...form, xAccounts: list(e.target.value).map((s) => s.replace(/^@/, "").toLowerCase()) })} />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {form.xAccounts.length} accounts
                {S.x.busy.length > 0 && <> · {t("admin.hot.xBusyNow")} {S.x.busy.map((b) => `@${b.handle} ${b.perDay}/d`).join(", ")}</>}
              </p>
            </Field>
            <Field label={t("admin.hot.xAccountsInterval")}><Input type="number" min={15} value={Math.round(form.xAccountsIntervalMs / 60000)} disabled={!canAct} className="w-28 font-mono" onChange={(e) => setForm({ ...form, xAccountsIntervalMs: Number(e.target.value) * 60000 })} /></Field>
            <Field label={t("admin.hot.xBusy")}>
              <div className="flex gap-2">
                <Input type="number" min={0} value={form.xBusyPostsPerDay} disabled={!canAct} className="w-24 font-mono" onChange={(e) => num("xBusyPostsPerDay", e.target.value)} />
                <Input type="number" min={60} step={60} value={Math.round(form.xBusyIntervalMs / 60000)} disabled={!canAct} className="w-24 font-mono" onChange={(e) => setForm({ ...form, xBusyIntervalMs: Number(e.target.value) * 60000 })} />
                <Input type="number" min={1} value={form.xBusyReadPerDay} disabled={!canAct} className="w-24 font-mono" onChange={(e) => num("xBusyReadPerDay", e.target.value)} />
              </div>
            </Field>
            <Field label={t("admin.hot.xBreakout")}><Switch checked={form.xBreakoutEnabled} disabled={!canAct} onCheckedChange={(v) => setForm({ ...form, xBreakoutEnabled: v })} /></Field>
            <Field label={t("admin.hot.xBreakoutInterval")}><Input type="number" min={15} value={Math.round(form.xBreakoutIntervalMs / 60000)} disabled={!canAct} className="w-28 font-mono" onChange={(e) => setForm({ ...form, xBreakoutIntervalMs: Number(e.target.value) * 60000 })} /></Field>
            <Field label={t("admin.hot.xBreakoutMin")}>
              <div className="flex gap-2">
                <Input type="number" min={100} value={form.xBreakoutMinLikes} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("xBreakoutMinLikes", e.target.value)} />
                <Input type="number" min={0} value={form.xBreakoutMinReposts} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("xBreakoutMinReposts", e.target.value)} />
                <Input value={form.xBreakoutLang} maxLength={2} disabled={!canAct} className="w-16 font-mono" onChange={(e) => setForm({ ...form, xBreakoutLang: e.target.value.toLowerCase() })} />
              </div>
            </Field>
            <Field label={t("admin.hot.xDailyPostCap")}><Input type="number" min={0} value={form.xDailyPostCap} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("xDailyPostCap", e.target.value)} /></Field>
            <Field label={t("admin.hot.xDailyBudget")}><Input type="number" min={0} step={0.5} value={form.xDailyBudgetUsd} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("xDailyBudgetUsd", e.target.value)} /></Field>
            <Field label={t("admin.hot.publicWindow")}><Input type="number" min={1} value={form.publicWindowHours} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("publicWindowHours", e.target.value)} /></Field>
            <Field label={t("admin.hot.xPublicMax")}><Input type="number" min={5} value={form.xPublicMax} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("xPublicMax", e.target.value)} /></Field>
            <Field label={t("admin.hot.weiboPublicMax")}><Input type="number" min={5} value={form.weiboPublicMax} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("weiboPublicMax", e.target.value)} /></Field>
            <Field label={t("admin.hot.aiFilter")}><Switch checked={form.aiFilter} disabled={!canAct} onCheckedChange={(v) => setForm({ ...form, aiFilter: v })} /></Field>
            <Field label={t("admin.hot.pregenTop")}><Input type="number" min={0} value={form.pregenTop} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("pregenTop", e.target.value)} /></Field>
            <Field label={t("admin.hot.pregenLogos")}><Switch checked={form.pregenLogos} disabled={!canAct} onCheckedChange={(v) => setForm({ ...form, pregenLogos: v })} /></Field>
            <Field label={t("admin.hot.aiDailyCap")}><Input type="number" min={0} value={form.aiDailyCap} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("aiDailyCap", e.target.value)} /></Field>
            <Field label={t("admin.hot.aiPerIpHour")}><Input type="number" min={0} value={form.aiPerIpHour} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("aiPerIpHour", e.target.value)} /></Field>
            <Field label={t("admin.hot.quotaAddress")}><Input type="number" min={0} value={form.quotaPerAddress} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("quotaPerAddress", e.target.value)} /></Field>
            <Field label={t("admin.hot.quotaIp")}><Input type="number" min={0} value={form.quotaPerIp} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("quotaPerIp", e.target.value)} /></Field>
            <Field label={t("admin.hot.aiDraftDaily")}><Input type="number" min={0} value={form.aiDraftDailyCap} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("aiDraftDailyCap", e.target.value)} /></Field>
            <Field label={t("admin.hot.aiDraftIp")}><Input type="number" min={0} value={form.aiDraftPerIpHour} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("aiDraftPerIpHour", e.target.value)} /></Field>
            <Field label={t("admin.hot.aiDraftWallet")}><Input type="number" min={0} value={form.aiDraftPerAddressDay} disabled={!canAct} className="w-28 font-mono" onChange={(e) => num("aiDraftPerAddressDay", e.target.value)} /></Field>
            <Field label={t("admin.hot.tax")}>
              <div className="flex gap-2">
                <Input type="number" min={0} max={1000} value={form.tax.buyTaxBps} disabled={!canAct} className="w-24 font-mono" onChange={(e) => setForm({ ...form, tax: { ...form.tax, buyTaxBps: Number(e.target.value) } })} />
                <Input type="number" min={0} max={1000} value={form.tax.sellTaxBps} disabled={!canAct} className="w-24 font-mono" onChange={(e) => setForm({ ...form, tax: { ...form.tax, sellTaxBps: Number(e.target.value) } })} />
                <Input type="number" min={0} max={10000} value={form.tax.marketingBps} disabled={!canAct} className="w-24 font-mono" onChange={(e) => setForm({ ...form, tax: { ...form.tax, marketingBps: Number(e.target.value) } })} />
              </div>
            </Field>
            <Field label={t("admin.hot.blacklist")} className="md:col-span-2">
              <Input value={form.blacklist.join(", ")} disabled={!canAct} onChange={(e) => setForm({ ...form, blacklist: list(e.target.value) })} />
            </Field>
          </div>
          {canAct && (
            <div className="flex flex-wrap gap-2">
              <Button variant="gold" disabled={busy === "save"} onClick={() => void save()}>{t("admin.hot.save")}</Button>
              <Button variant="outline" disabled={busy === "crawl"} onClick={() => void crawl()}><RefreshCw className={busy === "crawl" ? "animate-spin" : ""} /> {t("admin.hot.refresh")}</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <section>
        <SectionTitle>{t("admin.hot.list")}</SectionTitle>
        {data.items.length === 0 ? (
          <Empty>{t("hot.empty")}</Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("hot.source")}</TableHead>
                  <TableHead>{t("hot.title").split(" ")[0]}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("hot.regions")}</TableHead>
                  <TableHead>{t("common.token")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("admin.hot.aiPath")}</TableHead>
                  <TableHead className="text-right">{t("hot.launched")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("hot.lastSeen")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  {canAct && <TableHead className="text-right">{t("admin.col.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody className="text-xs">
                {listPg.pageItems.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell><span className="inline-flex items-center gap-1 whitespace-nowrap"><SourceIcon source={h.platform} /> {originLabel(h, locale)} <span className="text-muted-foreground">{t(typeKey(h.sourceType))}</span></span></TableCell>
                    <TableCell className="max-w-[240px]">
                      <div className="truncate" title={h.title}>{h.url ? <a href={h.url} target="_blank" rel="noreferrer nofollow" className="hover:underline">{h.title}</a> : h.title}</div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><CategoryBadge category={h.category} t={t} className="text-[10px]" />{h.related > 0 && <span>+{h.related}</span>}{h.rising && <span className="text-up">↑</span>}</div>
                    </TableCell>
                    <TableCell className="hidden font-mono text-muted-foreground lg:table-cell">{h.regions.join(" ")}</TableCell>
                    <TableCell>
                      {h.name ? (
                        <Link href={`/hot/${h.id}`} className="inline-flex items-center gap-2 hover:underline">
                          <TokenAvatar logo={h.logo ?? ""} symbol={h.symbol ?? "?"} seed={`hot:${h.id}`} size={20} className="rounded-sm" />
                          <span className="font-semibold">{h.name}</span><span className="font-mono text-muted-foreground">${h.symbol}</span>
                        </Link>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="hidden font-mono text-muted-foreground lg:table-cell">{h.ideasBy ?? "—"} / {h.logoBy ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono tabular">{h.launches}</TableCell>
                    <TableCell className="hidden font-mono text-muted-foreground md:table-cell"><TimeAgo ts={h.lastSeen} /></TableCell>
                    <TableCell>
                      <Badge variant={h.status === "published" ? "up" : h.status === "blocked" || h.status === "hidden" ? "secondary" : h.status === "expired" ? "outline" : "outline"} className={cn(h.status === "blocked" && "font-mono")}>
                        {h.status === "blocked" ? h.blockedReason ?? "blocked" : h.status}
                      </Badge>
                    </TableCell>
                    {canAct && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {h.status === "published" ? (
                            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act(h.id, "hide")}>{t("admin.hot.hide")}</Button>
                          ) : (
                            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act(h.id, "show")}>{t("admin.hot.show")}</Button>
                          )}
                          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act(h.id, "regenerate")}>{t("admin.hot.regen")}</Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={listPg.page} pageCount={listPg.pageCount} onChange={listPg.setPage} total={listPg.total} pageSize={listPg.pageSize} className="border-t px-4 py-2" />
          </Card>
        )}
      </section>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label className="label mb-1 block">{label}</Label>
      {children}
    </div>
  );
}
