"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { hotspotAdminMessage, postAdminDapps, useDappCatalogAdmin } from "@/lib/api";
import { DEFAULT_CATALOG, worksOn, type DappCategory, type DappItem } from "@/lib/wallet/dapp-catalog";
import { WALLET_CHAINS } from "@/lib/wallet/chains";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errMsg } from "@/components/shared";
import { cn } from "@/lib/utils";
import type { Sign } from "./hot-panel";

const move = <T,>(list: T[], i: number, d: -1 | 1) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Wallet DApp page catalogue: categories → DApps, each with the chains it supports. One owner-signed save for the
 *  whole list (the indexer validates it); "restore defaults" deletes the saved list. Read-only for non-owners. */
export function DappsPanel({ canAct }: { canAct: boolean }) {
  const { t, address } = useApp();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const q = useDappCatalogAdmin();
  const [draft, setDraft] = useState<DappCategory[] | null>(null);
  const [chain, setChain] = useState<string>("");
  const [busy, setBusy] = useState(false);

  if (!q.data) return <Skeleton className="h-64 rounded-xl" />;
  const saved = q.data.categories ?? DEFAULT_CATALOG;
  const cats = draft ?? saved;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  const off = !canAct || busy;

  const edit = (fn: (c: DappCategory[]) => DappCategory[]) => setDraft(fn(structuredClone(cats)));
  const setItem = (ci: number, ii: number, patch: Partial<DappItem>) =>
    edit((c) => {
      const it = { ...c[ci].items[ii], ...patch };
      for (const k of ["desc", "icon"] as const) if (!it[k]) delete it[k];
      if (!it.chains?.length) delete it.chains;
      c[ci].items[ii] = it;
      return c;
    });

  const send = async (payload: unknown, okMsg: string) => {
    if (!address) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const signature = await (signMessageAsync as Sign)({ message: hotspotAdminMessage("dapps", ts, payload) });
      const r = await postAdminDapps({ author: address, ts, signature, payload });
      qc.setQueryData(["admin", "dapps"], r);
      setDraft(null);
      toast.success(okMsg);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("admin.dapps.title")}</h2>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{t("admin.dapps.hint")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {q.data.categories ? `${t("admin.dapps.saved")} ${new Date(q.data.updatedAt!).toLocaleString()}` : t("admin.dapps.default")}
            {dirty && <span className="ml-2 font-medium text-gold">· {t("admin.dapps.unsaved")}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={chain} onChange={(e) => setChain(e.target.value)} className="h-8 rounded-lg border bg-background px-2 text-xs">
            <option value="">{t("admin.dapps.all")}</option>
            {WALLET_CHAINS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={off} onClick={() => edit((c) => [...c, { id: `cat-${c.length + 1}`, name: "", items: [] }])}>
            <Plus /> {t("admin.dapps.addCat")}
          </Button>
          <Button size="sm" variant="outline" disabled={off || !q.data.categories} onClick={() => window.confirm(t("admin.dapps.resetConfirm")) && void send({ reset: true }, t("admin.hot.saved"))}>
            <RotateCcw /> {t("admin.dapps.reset")}
          </Button>
          <Button size="sm" variant="gold" disabled={off || !dirty} onClick={() => void send({ categories: cats }, t("admin.hot.saved"))}>
            <Save /> {t("common.save")}
          </Button>
        </div>
      </div>

      {cats.map((cat, ci) => {
        const rows = cat.items.map((it, ii) => ({ it, ii })).filter(({ it }) => !chain || worksOn(it, chain));
        return (
          <div key={ci} className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input value={cat.name} disabled={off} placeholder={t("admin.dapps.catName")} onChange={(e) => edit((c) => ((c[ci].name = e.target.value), c))} className="h-8 w-40 text-sm font-semibold" />
              <Input value={cat.id} disabled={off} placeholder={t("admin.dapps.catId")} onChange={(e) => edit((c) => ((c[ci].id = e.target.value.toLowerCase()), c))} className="h-8 w-40 font-mono text-xs" />
              <span className="text-xs text-muted-foreground">{cat.items.length}</span>
              <div className="ml-auto flex gap-1">
                <Button size="icon-sm" variant="ghost" disabled={off || ci === 0} onClick={() => edit((c) => move(c, ci, -1))}><ArrowUp /></Button>
                <Button size="icon-sm" variant="ghost" disabled={off || ci === cats.length - 1} onClick={() => edit((c) => move(c, ci, 1))}><ArrowDown /></Button>
                <Button size="icon-sm" variant="ghost" disabled={off} onClick={() => window.confirm(`${cat.name || cat.id} ?`) && edit((c) => c.filter((_, i) => i !== ci))}><Trash2 className="text-destructive" /></Button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {rows.length === 0 && <p className="px-1 text-xs text-muted-foreground">{t("admin.dapps.empty")}</p>}
              {rows.map(({ it, ii }) => (
                <div key={ii} className="grid gap-2 rounded-lg bg-muted/40 p-2 lg:grid-cols-[10rem_1fr_1fr_auto]">
                  <Input value={it.name} disabled={off} placeholder={t("admin.dapps.name")} onChange={(e) => setItem(ci, ii, { name: e.target.value })} className="h-8 text-sm font-medium" />
                  <Input value={it.url} disabled={off} placeholder="https://" onChange={(e) => setItem(ci, ii, { url: e.target.value.trim() })} className="h-8 font-mono text-xs" />
                  <Input value={it.desc ?? ""} disabled={off} placeholder={t("admin.dapps.desc")} onChange={(e) => setItem(ci, ii, { desc: e.target.value })} className="h-8 text-xs" />
                  <div className="flex items-center gap-1">
                    <Button size="icon-sm" variant="ghost" disabled={off || ii === 0} onClick={() => edit((c) => ((c[ci].items = move(c[ci].items, ii, -1)), c))}><ArrowUp /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={off || ii === cat.items.length - 1} onClick={() => edit((c) => ((c[ci].items = move(c[ci].items, ii, 1)), c))}><ArrowDown /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={off} onClick={() => edit((c) => ((c[ci].items = c[ci].items.filter((_, i) => i !== ii)), c))}><Trash2 className="text-destructive" /></Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 lg:col-span-2">
                    {WALLET_CHAINS.map((c) => {
                      const on = !!it.chains?.includes(c.key);
                      return (
                        <button
                          key={c.key}
                          type="button"
                          disabled={off}
                          onClick={() => setItem(ci, ii, { chains: on ? it.chains!.filter((k) => k !== c.key) : [...(it.chains ?? []), c.key] })}
                          className={cn("rounded-full border px-2 py-0.5 text-[11px] transition disabled:opacity-50", on ? "border-foreground bg-foreground text-background" : "text-muted-foreground")}
                        >
                          {c.name}
                        </button>
                      );
                    })}
                    {!it.chains?.length && <span className="text-[11px] text-muted-foreground">= {t("admin.dapps.all")}</span>}
                  </div>
                  <Input value={it.icon ?? ""} disabled={off} placeholder={t("admin.dapps.icon")} onChange={(e) => setItem(ci, ii, { icon: e.target.value.trim() })} className="h-8 font-mono text-[11px] lg:col-span-2" />
                </div>
              ))}
              <Button size="sm" variant="ghost" disabled={off} onClick={() => edit((c) => (c[ci].items.push({ name: "", url: "https://", ...(chain ? { chains: [chain] } : {}) }), c))}>
                <Plus /> {t("admin.dapps.addItem")}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
