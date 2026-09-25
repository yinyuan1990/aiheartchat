"use client";

import { useState } from "react";
import { ExternalLink, Flame, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { hotspotAdminMessage, postAdminBurn, postAdminBurnAction, tok, useAdminBurns, useBurn, usd, type AdminOverview } from "@/lib/api";
import { fmtNum, fmtUsd, shortAddr } from "@/lib/format";
import { addrUrl, txUrl } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, SectionTitle, Stat, TimeAgo, errMsg } from "@/components/shared";
import { type Sign, signedCall } from "./hot-panel";

/** Owner-signed envelope for the burn endpoints (same message format the indexer verifies for hotspot admin). */
async function signedBody(sign: Sign, address: string | undefined, action: string, payload: unknown) {
  if (!address) throw new Error("connect wallet");
  const ts = Date.now();
  const signature = await sign({ message: hotspotAdminMessage(action, ts, payload) });
  return { author: address, ts, signature, payload };
}

/** v2.10 (boss 9.14): the buyback multisig burns by hand; the owner records each burn here by tx hash. The indexer
 *  accepts only receipts that succeeded on this chain and reads the burned amount from the Transfer logs. */
export function BurnsPanel({ ov, canAct }: { ov: AdminOverview; canAct: boolean }) {
  const { t, address } = useApp();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const { data } = useAdminBurns(true);
  const [hash, setHash] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const pg = usePage(data?.items, 25);
  const signed = (action: string, payload: unknown) => signedBody(signMessageAsync as Sign, address, action, payload);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "burns"] });
    void qc.invalidateQueries({ queryKey: ["admin", "overview"] });
  };

  const add = async () => {
    const h = hash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return toast.error(t("admin.burns.hash"));
    setBusy("add");
    try {
      const r = await postAdminBurn(await signed("burn:add", { hash: h, note: note.trim() }));
      if (r.burnFound) toast.success(t("admin.burns.added"), { description: `${fmtNum(Number(r.item.tokensBurned) / 1e18)} ${r.item.symbol ?? ""}` });
      else toast.warning(t("admin.burns.noBurnFound"));
      setHash("");
      setNote("");
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (id: number) => {
    setBusy(`del:${id}`);
    try {
      await postAdminBurnAction(id, await signed(`burn:${id}`, { action: "delete" }));
      refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const fund = ov.params.treasury.buybackFund;
  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("admin.burns.fund")} value={<a href={addrUrl(fund)} target="_blank" rel="noreferrer" className="font-mono text-base hover:underline">{shortAddr(fund, 6, 4)}</a>} sub={t("admin.burns.fundHint")} tone="gold" />
        <Stat label={t("admin.burns.received")} value={fmtUsd(usd(ov.totals.to_buyback))} sub={`${t("admin.kpi.treasury")} ${fmtUsd(usd(ov.params.treasury.pendingRevenueUsdc) * 0.2)}`} />
        <Stat label={t("admin.burns.total")} value={data ? fmtNum(Number(data.totals.burned) / 1e18) : "…"} sub={data ? `${data.totals.n} tx · ${t("admin.burns.spent")} ${fmtUsd(usd(data.totals.usdcSpent))}` : undefined} tone="gold" />
      </section>

      <BurnCardSettings canAct={canAct} />

      <Card>
        <CardContent className="space-y-3">
          <SectionTitle>{t("admin.burns.title")}</SectionTitle>
          <p className="text-xs text-muted-foreground">{t("admin.burns.hint")}</p>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="burn-hash" className="label">{t("admin.burns.hash")}</Label>
              <Input id="burn-hash" value={hash} disabled={!canAct} placeholder="0x…" className="font-mono" onChange={(e) => setHash(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="burn-note" className="label">{t("admin.burns.note")}</Label>
              <Input id="burn-note" value={note} disabled={!canAct} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button variant="gold" disabled={!canAct || busy === "add" || !hash.trim()} onClick={() => void add()}><Flame /> {t("admin.burns.add")}</Button>
          </div>
        </CardContent>
      </Card>

      <section>
        {!data || data.items.length === 0 ? (
          <Empty>{t("common.noData")}</Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.time")}</TableHead>
                  <TableHead>{t("admin.col.token")}</TableHead>
                  <TableHead className="text-right">{t("admin.burns.burned")}</TableHead>
                  <TableHead className="text-right">{t("admin.burns.spent")}</TableHead>
                  <TableHead>{t("admin.burns.sender")}</TableHead>
                  <TableHead>{t("admin.burns.note")}</TableHead>
                  <TableHead className="text-right">Tx</TableHead>
                  {canAct && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs tabular">
                {pg.pageItems.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell><TimeAgo ts={b.time} /></TableCell>
                    <TableCell>{b.symbol ?? (b.token ? shortAddr(b.token, 4, 4) : "—")}</TableCell>
                    <TableCell className="text-right">{fmtNum(Number(b.tokensBurned) / 1e18)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(usd(b.usdcSpent))}</TableCell>
                    <TableCell><a href={addrUrl(b.sender)} target="_blank" rel="noreferrer" className="hover:underline">{shortAddr(b.sender, 4, 4)}</a></TableCell>
                    <TableCell className="max-w-[16rem] truncate font-sans" title={b.note}>{b.note || "—"}</TableCell>
                    <TableCell className="text-right"><a href={txUrl(b.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{shortAddr(b.hash, 6, 4)} <ExternalLink size={11} /></a></TableCell>
                    {canAct && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="xs" disabled={busy === `del:${b.id}`} onClick={() => void remove(b.id)} title={t("admin.burns.delete")}><Trash2 /></Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={pg.page} pageCount={pg.pageCount} onChange={pg.setPage} total={pg.total} pageSize={pg.pageSize} className="border-t px-4 py-2" />
          </Card>
        )}
      </section>
    </div>
  );
}

/** ISO → value for <input type="datetime-local"> in the browser's zone (what the owner sees when picking). */
const toLocalInput = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Owner controls for the public "next burn" card (boss 9.23): two independent placement switches (home page strip,
 *  burned token's page) save instantly; token / quantity / interval / next-burn save together. Blank / 0 = derived
 *  from the latest recorded burn. */
function BurnCardSettings({ canAct }: { canAct: boolean }) {
  const { t, address } = useApp();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const burn = useBurn();
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ token: string; amount: string; interval: string; nextAt: string } | null>(null);
  const cfg = burn.data?.config;
  const form = edit ?? { token: cfg?.token ?? "", amount: cfg && cfg.amount > 0 ? String(cfg.amount) : "", interval: cfg ? String(cfg.intervalDays) : "7", nextAt: toLocalInput(cfg?.nextAt ?? "") };
  const off = !canAct || busy || !burn.data;

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await signedCall(signMessageAsync as Sign, address, "settings", "/settings", patch);
      toast.success(t("admin.hot.saved"));
      await qc.invalidateQueries({ queryKey: ["burn"] });
      setEdit(null);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const saveForm = () => {
    const token = form.token.trim();
    if (token && !/^0x[0-9a-fA-F]{40}$/.test(token)) return toast.error(t("admin.burnCard.token"));
    const interval = Number(form.interval);
    if (!Number.isFinite(interval) || interval <= 0) return toast.error(t("admin.burnCard.interval"));
    const nextAt = form.nextAt ? new Date(form.nextAt) : null;
    if (nextAt && !Number.isFinite(nextAt.getTime())) return toast.error(t("admin.burnCard.nextAt"));
    void save({ burnToken: token, burnAmount: Number(form.amount) || 0, burnIntervalDays: interval, burnNextAt: nextAt ? nextAt.toISOString() : "" });
  };

  const d = burn.data;
  const sym = d?.token?.symbol ?? "";
  const inEffect = d
    ? [
        d.token ? `${d.token.name ?? sym} (${shortAddr(d.token.address, 6, 4)})` : "—",
        d.amount !== "0" ? `${fmtNum(tok(d.amount))} ${sym} ≈ ${fmtUsd(d.amountUsd)}` : "—",
        d.nextAt ? new Date(d.nextAt).toLocaleString() : "—",
      ].join(" · ")
    : "…";

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle className="mb-0">{t("admin.burnCard.title")}</SectionTitle>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-2">
              <Switch id="bc-home" checked={d?.showHome ?? false} disabled={off} onCheckedChange={(v) => void save({ burnCardHome: v })} />
              <Label htmlFor="bc-home" className="text-xs">{t("admin.burnCard.home")}</Label>
            </label>
            <label className="inline-flex items-center gap-2">
              <Switch id="bc-token" checked={d?.showToken ?? true} disabled={off} onCheckedChange={(v) => void save({ burnCardToken: v })} />
              <Label htmlFor="bc-token" className="text-xs">{t("admin.burnCard.tokenPage")}</Label>
            </label>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("admin.burnCard.hint")}</p>
        <div className="grid gap-3 md:grid-cols-[1.6fr_1fr_0.6fr_1fr_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="bc-tok" className="label">{t("admin.burnCard.token")}</Label>
            <Input id="bc-tok" value={form.token} disabled={off} placeholder={d?.token?.address ?? "0x…"} className="font-mono" onChange={(e) => setEdit({ ...form, token: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bc-amt" className="label">{t("admin.burnCard.amount")}</Label>
            <Input id="bc-amt" type="number" min={0} step={1} value={form.amount} disabled={off} placeholder={d && d.amount !== "0" ? fmtNum(tok(d.amount)) : "0"} className="font-mono" onChange={(e) => setEdit({ ...form, amount: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bc-int" className="label">{t("admin.burnCard.interval")}</Label>
            <Input id="bc-int" type="number" min={0.01} step={1} value={form.interval} disabled={off} className="font-mono" onChange={(e) => setEdit({ ...form, interval: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bc-next" className="label">{t("admin.burnCard.nextAt")}</Label>
            <Input id="bc-next" type="datetime-local" value={form.nextAt} disabled={off} className="font-mono" onChange={(e) => setEdit({ ...form, nextAt: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <Button variant="gold" disabled={off || !edit} onClick={saveForm}>{t("common.save")}</Button>
            <Button variant="outline" disabled={off} title={t("admin.burnCard.clear")} onClick={() => void save({ burnToken: "", burnAmount: 0, burnIntervalDays: 7, burnNextAt: "" })}>{t("admin.burnCard.clear")}</Button>
          </div>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">{t("admin.burnCard.derived").replace("{v}", inEffect)}</p>
      </CardContent>
    </Card>
  );
}
