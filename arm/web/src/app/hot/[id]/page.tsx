"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowUp, ExternalLink, ImagePlus, Layers, Lock, Percent, RefreshCw, Rocket, Sparkles, Wallet, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { claimHotspot, generateHotspotLogo, prepareHotspot, reportHotspotLaunch, uploadLogo, useConfig, useHotspot, useHotspotQuota, type HotspotDetail, type HotspotLang } from "@/lib/api";
import { fmtUsd, shortAddr } from "@/lib/format";
import { ADDR, erc20Abi } from "@/lib/web3";
import { useLaunch } from "@/lib/launch";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, TimeAgo, TokenAvatar, errMsg } from "@/components/shared";
import { CategoryBadge, SHOW_PLATFORM_LABEL, SourceIcon, heatOf, localizeHotspot, originLabel, displayRegions, regionLabel, typeKey } from "@/components/hot/source";

type Mode = "standard" | "tax";
const FIRST_BUY_OPTIONS = [0, 1, 5, 10];
const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,7}$/;

/**
 * Launch page (spec §8): opening it is the "Launch" click, so the AI copy is generated here — once per hotspot, then
 * cached for everyone. Name / symbol / description are editable; the logo is AI-generated on request or uploaded.
 */
export default function HotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale, connected, address, wrongChain, toggleConnect } = useApp();
  const router = useRouter();
  const qc = useQueryClient();
  const { launch } = useLaunch();
  const { data: h, isLoading, isError } = useHotspot(id);
  const quotaQ = useHotspotQuota(address);
  const cfg = useConfig().data;
  const [mode, setMode] = useState<Mode>("standard");
  const [firstBuy, setFirstBuy] = useState(0);
  const [buyTaxPct, setBuyTaxPct] = useState<number | null>(null);
  const [sellTaxPct, setSellTaxPct] = useState<number | null>(null);
  const [marketingWallet, setMarketingWallet] = useState("");
  const [teamWallet, setTeamWallet] = useState("");
  const [chainLangPick, setChainLangPick] = useState<HotspotLang | null>(null);
  // hand edits of the AI copy; null = keep what the AI drafted
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [symbolEdit, setSymbolEdit] = useState<string | null>(null);
  const [descEdit, setDescEdit] = useState<string | null>(null);
  const [logoEdit, setLogoEdit] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [painting, setPainting] = useState(false);
  const [busy, setBusy] = useState<null | "claim" | "launch">(null);
  const prepared = useRef(false);

  // AI on click: the first visit of an unprepared hotspot triggers the (single, cached) copy generation
  const prepare = useMutation({
    mutationFn: (hid: number) => prepareHotspot(hid),
    onSuccess: (d) => qc.setQueryData<HotspotDetail>(["hotspot", id], (old) => ({ ...(old ?? d), ...d, tax: d.tax ?? old?.tax })),
  });
  const { mutate: runPrepare } = prepare;
  useEffect(() => {
    if (!h || h.prepared || prepared.current) return;
    prepared.current = true;
    runPrepare(h.id);
  }, [h, runPrepare]);
  const preparing = prepare.isPending;
  const prepareError = prepare.error ? errMsg(prepare.error) : null;

  const me = address as Address | undefined;
  const balQ = useReadContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 8000 } });

  if (isLoading) return <div className="mx-auto max-w-5xl space-y-4"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-80 rounded-xl" /></div>;
  if (isError || !h) return <Empty>{t("hot.empty")}</Empty>;
  const ready = h.prepared && !!h.name && !!h.symbol;
  const L = localizeHotspot(h, locale);
  const chainLang: HotspotLang = L.bilingual ? (chainLangPick ?? locale) : "en";
  const aiName = (chainLang === "zh" && h.nameZh ? h.nameZh : h.name) ?? "";
  const aiDesc = (chainLang === "zh" && h.descriptionZh ? h.descriptionZh : h.description) ?? "";
  const aiSymbol = h.symbol ?? "";
  const chainName = nameEdit !== null ? nameEdit : aiName;
  const chainSymbol = (symbolEdit !== null ? symbolEdit : aiSymbol).toUpperCase();
  const chainDesc = descEdit !== null ? descEdit : aiDesc;
  const nameOk = chainName.trim().length >= 1;
  const symbolOk = SYMBOL_RE.test(chainSymbol);
  const logo = logoEdit ?? h.logo ?? "";
  const heat = heatOf(h, t);
  const all = displayRegions(h.regions);
  const regions = all.filter((r) => r !== "WW" || all.length === 1);

  const onPickFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 1024 * 1024) return toast.error("max 1 MB");
    setUploading(true);
    try {
      const { url } = await uploadLogo(file);
      setLogoEdit(url);
      toast.success(t("create.uploaded"));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setUploading(false);
    }
  };
  const paint = async () => {
    setPainting(true);
    try {
      const r = await generateHotspotLogo(h.id);
      setLogoEdit(null);
      qc.setQueryData<HotspotDetail>(["hotspot", id], (old) => (old ? { ...old, logo: r.logo } : old));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setPainting(false);
    }
  };

  const fee6 = cfg ? BigInt(cfg.params.creationFee) : 0n;
  const buy6 = BigInt(firstBuy) * 1_000_000n;
  const need6 = fee6 + buy6;
  const balance = balQ.data ?? 0n;
  const insufficient = connected && need6 > balance;
  const quota = quotaQ.data;
  const quotaLeft = quota ? Math.min(quota.address, quota.ip) : null;
  const quotaHit = quotaLeft !== null && quotaLeft <= 0;
  const maxTaxPct = (cfg?.params.maxTaxBps ?? 1000) / 100;
  const buyPct = Math.min(buyTaxPct ?? h.tax.buyTaxBps / 100, maxTaxPct);
  const sellPct = Math.min(sellTaxPct ?? h.tax.sellTaxBps / 100, maxTaxPct);
  const taxDesc = t("hot.mode.taxDesc").replace("{b}", String(buyPct)).replace("{s}", String(sellPct)).replace("{m}", String(h.tax.marketingBps / 100));
  const mkTrim = marketingWallet.trim();
  const tmTrim = teamWallet.trim();
  const mkValid = mkTrim === "" || isAddress(mkTrim);
  const tmValid = tmTrim === "" || isAddress(tmTrim);
  const walletsValid = mode !== "tax" || (mkValid && tmValid);
  const addrOrZero = (s: string) => (s && isAddress(s) ? getAddress(s) : zeroAddress) as Address;

  const confirm = async () => {
    if (!me) return toggleConnect();
    setBusy("claim");
    try {
      const claim = await claimHotspot(h.id, {
        address: me, mode, buyTaxBps: Math.round(buyPct * 100), sellTaxBps: Math.round(sellPct * 100), lang: chainLang,
        name: chainName.trim() !== aiName ? chainName.trim() : undefined,
        symbol: chainSymbol !== aiSymbol ? chainSymbol : undefined,
        description: chainDesc.trim() !== aiDesc ? chainDesc.trim() : undefined,
        logo: logoEdit ?? undefined,
      });
      setBusy("launch");
      const res = await launch(
        {
          name: claim.params.name,
          symbol: claim.params.symbol,
          logo: claim.params.logo,
          description: claim.params.description,
          socials: claim.params.socials,
          buyTaxBps: claim.params.buyTaxBps,
          sellTaxBps: claim.params.sellTaxBps,
          marketingBps: claim.params.marketingBps,
          marketingWallet: mode === "tax" ? addrOrZero(mkTrim) : zeroAddress,
          teamWallet: mode === "tax" ? addrOrZero(tmTrim) : zeroAddress,
          initialBuyUsdc: buy6,
        },
        fee6,
      );
      if (!res) return;
      if (res.token) void reportHotspotLaunch(claim.claimId, { address: me, token: res.token, txHash: res.hash }).catch(() => {});
      toast.success(t("tx.launched"), { description: res.token });
      void qc.invalidateQueries({ queryKey: ["hotspots"] });
      void qc.invalidateQueries({ queryKey: ["hotspot", id] });
      void qc.invalidateQueries({ queryKey: ["tokens"] });
      setTimeout(() => router.push(res.token ? `/token/${res.token}` : "/hot"), 2500);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const canConfirm = ready && !busy && !wrongChain && !insufficient && !quotaHit && walletsValid && nameOk && symbolOk && !uploading && !painting;

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-28">
      <Link href="/hot" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={14} /> {t("nav.hot")}</Link>

      {/* Signal header: platform · type · regions · time · source · related */}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {SHOW_PLATFORM_LABEL && <span className="inline-flex items-center gap-1 font-medium text-foreground"><SourceIcon source={h.platform} /> {originLabel(h, locale)}</span>}
            <span className="rounded bg-muted px-1 py-px text-[10px]">{t(typeKey(h.sourceType))}</span>
            {h.rising && <span className="inline-flex items-center gap-0.5 text-up"><ArrowUp size={11} /> {t("hot.rising")}</span>}
            {heat && <span>{heat}</span>}
            <span>{t("hot.firstSeen")} <TimeAgo ts={h.firstSeen} /></span>
            <span>· {t("hot.lastSeen")} <TimeAgo ts={h.lastSeen} /></span>
            <CategoryBadge category={h.category} t={t} />
            {h.launches > 0 && <Badge variant="gold">{t("hot.launchedN").replace("{n}", String(h.launches))}</Badge>}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{L.title}</h1>
              {L.title !== h.title && <div className="mt-1 text-sm text-muted-foreground">{t("hot.original")}: {h.title}</div>}
              {regions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {regions.map((r) => <span key={r} className="rounded-md border px-1.5 py-px text-[10px] text-muted-foreground">{regionLabel(r, t)}</span>)}
                  <span className="px-1 text-[10px] text-muted-foreground">{h.signals} {t("hot.signals")}</span>
                </div>
              )}
            </div>
            {h.url && (
              <Button variant="outline" size="sm" asChild>
                <a href={h.url} target="_blank" rel="noreferrer nofollow"><ExternalLink /> {t("hot.viewSource")}</a>
              </Button>
            )}
          </div>
          {h.context.length > 0 && (
            <div className="rounded-lg bg-muted/60 p-3 text-xs text-secondary-foreground">
              <div className="mb-1 font-semibold text-foreground">{t("hot.context")}</div>
              <ul className="list-disc space-y-0.5 pl-4">{h.context.slice(0, 4).map((c, i) => <li key={i} className="line-clamp-2">{c}</li>)}</ul>
            </div>
          )}
          {h.relatedSignals.length > 0 && (
            <div className="text-xs">
              <div className="mb-1 inline-flex items-center gap-1 font-semibold"><Layers size={12} /> {t("hot.relatedSignals")} · {h.related}</div>
              <div className="flex flex-wrap gap-1.5">
                {h.relatedSignals.map((r, i) => (
                  r.url
                    ? <a key={i} href={r.url} target="_blank" rel="noreferrer nofollow" className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground hover:text-foreground hover:underline">{r.title.slice(0, 40)}{r.region !== "WW" ? ` · ${regionLabel(r.region, t)}` : ""}</a>
                    : <span key={i} className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">{r.title.slice(0, 40)}</span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mode tabs */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="standard"><Lock className="mr-1 size-3.5" />{t("hot.mode.standard")}</TabsTrigger>
          <TabsTrigger value="tax"><Percent className="mr-1 size-3.5" />{t("hot.mode.tax")}</TabsTrigger>
        </TabsList>
        {(["standard", "tax"] as Mode[]).map((m) => (
          <TabsContent key={m} value={m} className="mt-3">
            <Card>
              <CardContent className="grid gap-5 md:grid-cols-[1fr_300px]">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="label flex items-center gap-1"><Sparkles size={12} className="text-primary" /> {t("hot.identity")}</div>
                    {L.bilingual && (
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {t("hot.chainLang")}
                        <Tabs value={chainLang} onValueChange={(v) => setChainLangPick(v as HotspotLang)}>
                          <TabsList className="h-7">
                            <TabsTrigger value="zh" className="px-2 text-xs">中文</TabsTrigger>
                            <TabsTrigger value="en" className="px-2 text-xs">English</TabsTrigger>
                          </TabsList>
                        </Tabs>
                      </div>
                    )}
                  </div>

                  {!ready ? (
                    <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm">
                      {preparing || (!prepareError && !h.prepared) ? (
                        <><RefreshCw size={16} className="shrink-0 animate-spin text-primary" /> <span className="text-secondary-foreground">{t("hot.preparing")}</span></>
                      ) : (
                        <>
                          <span className="text-down">{prepareError ?? t("hot.prepareFailed")}</span>
                          <Button size="sm" variant="outline" onClick={() => { prepare.reset(); runPrepare(h.id); }}><Wand2 /> {t("hot.prepare")}</Button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-start gap-4">
                      {/* logo: AI-generate on request, or upload; neither → monogram at launch */}
                      <div className="flex shrink-0 flex-col items-center gap-1.5">
                        <label className={cn("group relative block cursor-pointer overflow-hidden rounded-lg", (uploading || painting) && "opacity-60")} title={t("hot.editLogo")}>
                          <TokenAvatar logo={logo} symbol={chainSymbol || "?"} seed={`hot:${h.id}`} size={72} />
                          <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                            {uploading || painting ? <RefreshCw size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                          </span>
                          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" disabled={uploading || painting} onChange={(e) => void onPickFile(e.target.files?.[0])} />
                        </label>
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={painting || uploading} onClick={() => void paint()}>
                          <Wand2 className="size-3" /> {painting ? t("hot.genLogoBusy") : t("hot.genLogo")}
                        </Button>
                        {logoEdit !== null ? (
                          <button type="button" className="text-[10px] text-muted-foreground hover:underline" onClick={() => setLogoEdit(null)}>{t("hot.logoReset")}</button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">{t("hot.editLogo")}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                          <div>
                            <Label htmlFor={`hot-name-${m}`} className="label">{t("hot.editName")}</Label>
                            <Input id={`hot-name-${m}`} value={chainName} maxLength={32} onChange={(e) => setNameEdit(e.target.value)} className={cn("mt-1 h-9 text-base font-bold", !nameOk && "border-down")} />
                            {nameEdit !== null && nameEdit !== aiName && <button type="button" className="mt-0.5 text-[11px] text-muted-foreground hover:underline" onClick={() => setNameEdit(null)}>{t("hot.nameReset")}</button>}
                          </div>
                          <div>
                            <Label htmlFor={`hot-symbol-${m}`} className="label">{t("hot.editSymbol")}</Label>
                            <Input id={`hot-symbol-${m}`} value={chainSymbol} maxLength={8} onChange={(e) => setSymbolEdit(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} className={cn("mt-1 h-9 font-mono font-semibold uppercase", !symbolOk && "border-down")} />
                            {!symbolOk ? <p className="mt-0.5 text-[11px] text-down">{t("hot.symbolInvalid")}</p> : symbolEdit !== null && symbolEdit !== aiSymbol ? <button type="button" className="mt-0.5 text-[11px] text-muted-foreground hover:underline" onClick={() => setSymbolEdit(null)}>{t("hot.symbolReset")}</button> : null}
                          </div>
                        </div>
                        <div>
                          <Label htmlFor={`hot-desc-${m}`} className="label">{t("hot.editDesc")}</Label>
                          <Textarea id={`hot-desc-${m}`} value={chainDesc} maxLength={400} rows={3} onChange={(e) => setDescEdit(e.target.value)} className="mt-1 text-sm" />
                          {descEdit !== null && descEdit !== aiDesc && <button type="button" className="mt-0.5 text-[11px] text-muted-foreground hover:underline" onClick={() => setDescEdit(null)}>{t("hot.descReset")}</button>}
                        </div>
                        {L.bilingual && <p className="text-[11px] text-muted-foreground">{chainLang === "zh" ? h.name : h.nameZh} · {chainLang === "zh" ? h.description : h.descriptionZh}</p>}
                        {m === "tax" && <Badge variant="gold"><Percent /> {buyPct}% · {sellPct}%</Badge>}
                      </div>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">{t("hot.aiNote")} {t("hot.noLogoHint")}{L.bilingual ? ` ${t("hot.chainLangHint")}` : ""}</p>
                  {m === "tax" && (
                    <div className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-2">
                      <Range label={t("tax.buy")} value={buyPct} max={maxTaxPct} onChange={setBuyTaxPct} />
                      <Range label={t("tax.sell")} value={sellPct} max={maxTaxPct} onChange={setSellTaxPct} />
                      <p className="text-[11px] text-muted-foreground sm:col-span-2">{t("hot.taxHint").replace("{max}", String(maxTaxPct))}</p>
                      <div>
                        <Label htmlFor="hot-mk" className="label">{t("tax.marketingWallet")} <span className="font-mono text-gold">{h.tax.marketingBps / 100}%</span></Label>
                        <Input id="hot-mk" value={marketingWallet} onChange={(e) => setMarketingWallet(e.target.value)} placeholder={me ?? "0x…"} className={cn("mt-1 font-mono", !mkValid && "border-down")} />
                        {!mkValid && <p className="mt-1 text-[11px] text-down">{t("tax.walletInvalid")}</p>}
                      </div>
                      <div>
                        <Label htmlFor="hot-tm" className="label">{t("tax.teamWallet")} <span className="font-mono text-gold">{100 - h.tax.marketingBps / 100}%</span></Label>
                        <Input id="hot-tm" value={teamWallet} onChange={(e) => setTeamWallet(e.target.value)} placeholder={me ?? "0x…"} className={cn("mt-1 font-mono", !tmValid && "border-down")} />
                        {!tmValid && <p className="mt-1 text-[11px] text-down">{t("tax.walletInvalid")}</p>}
                      </div>
                      <p className="text-[11px] text-muted-foreground sm:col-span-2">{t("hot.walletsHint")}</p>
                    </div>
                  )}
                </div>
                <div className="space-y-3 rounded-lg bg-muted/60 p-3 text-xs">
                  <div className="label">{t("hot.economics")}</div>
                  <p className="text-secondary-foreground">{m === "standard" ? t("hot.mode.standardDesc") : taxDesc}</p>
                  <Row k={t("create.startMcap")} v={cfg ? fmtUsd(Number(cfg.params.startMcapUsdc) / 1e6, { compact: true }) : "…"} />
                  <Row k={t("token.threshold")} v={cfg ? fmtUsd(Number(cfg.params.graduationThreshold) / 1e6, { compact: true }) : "…"} />
                  <Row k={t("tax.buy")} v={m === "tax" ? `${buyPct}%` : "0%"} />
                  <Row k={t("tax.sell")} v={m === "tax" ? `${sellPct}%` : "0%"} />
                  <Row k={t("creator.payoutAddr")} v={me ? shortAddr(me, 6, 4) : "—"} mono />
                  <p className="text-[11px] text-muted-foreground">{t("hot.payoutNote")}</p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>

      <Card size="sm">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium">{t("hot.firstBuy")}</div>
          <div className="flex gap-1.5">
            {FIRST_BUY_OPTIONS.map((v) => (
              <Button key={v} size="sm" variant={firstBuy === v ? "default" : "outline"} onClick={() => setFirstBuy(v)} className="font-mono">{v === 0 ? "—" : `$${v}`}</Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {h.tokens.length > 0 && (
        <Card size="sm">
          <CardContent>
            <div className="label mb-2">{t("hot.otherLaunches")}</div>
            <div className="flex flex-wrap gap-2">
              {h.tokens.map((tk) => (
                <Link key={tk.address} href={`/token/${tk.address}`} className="inline-flex items-center gap-2 rounded-lg border px-2 py-1 text-xs hover:bg-muted">
                  <TokenAvatar logo={tk.logo} symbol={tk.symbol} seed={tk.address} size={18} className="rounded-sm" />
                  <span className="font-mono font-semibold">${tk.symbol}</span>
                  <span className="text-muted-foreground">{tk.mode === "tax" ? t("hot.mode.tax") : t("hot.mode.standard")} · {shortAddr(tk.deployer, 4, 4)}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sticky confirm bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-sidebar/90 backdrop-blur lg:left-60">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-3 py-3 md:px-6">
          <div className="text-xs text-muted-foreground">
            <span>{t("hot.fee")} <span className="font-mono font-semibold text-foreground">{fee6 > 0n ? fmtUsd(Number(fee6) / 1e6) : t("create.feeFree")}</span></span>
            {firstBuy > 0 && <span> + {t("hot.firstBuy").replace(/（.*）|\s*\(.*\)/, "")} <span className="font-mono font-semibold text-foreground">${firstBuy}</span></span>}
            <span className="ml-2">{t("hot.total")} <span className="font-mono text-sm font-bold text-foreground">{fmtUsd(Number(need6) / 1e6)}</span></span>
            {connected && quota && <span className={cn("ml-3", quotaHit ? "text-down" : "")}>{t("hot.quota")} <span className="font-mono">{quotaLeft}</span></span>}
          </div>
          {!connected ? (
            <Button variant="glow" size="lg" onClick={toggleConnect}><Wallet /> {t("common.connect")}</Button>
          ) : (
            <Button variant="glow" size="lg" disabled={!canConfirm} onClick={() => void confirm()}>
              <Rocket /> {busy === "claim" ? t("hot.claiming") : busy === "launch" ? t("create.step.launch") : insufficient ? t("tx.insufficient") : quotaHit ? t("hot.quotaHit").replace("{n}", String(quota?.perAddress ?? "")) : t("hot.confirm")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Range({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold text-gold tabular">{value}%</span>
      </div>
      <input type="range" min={0} max={max} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--gold)]" />
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("font-semibold", mono && "font-mono")}>{v}</span>
    </div>
  );
}
