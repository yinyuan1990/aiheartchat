"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ImagePlus, LineChart, Lock, Percent, RefreshCw, Rocket, Scale, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useGasPrice, useReadContract } from "wagmi";
import { formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { aiTokenDraft, uploadLogo, useAiDraftQuota, useConfig, useQuotes } from "@/lib/api";
import { fmtNum, fmtUsd } from "@/lib/format";
import { ADDR, IS_TESTNET, NET, QUOTES, STOCK_LAUNCH_UI, SUPPLY_TOKENS, erc20Abi } from "@/lib/web3";
import { useLaunch } from "@/lib/launch";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { TokenAvatar, errMsg } from "@/components/shared";

const EMOJIS = ["🚀", "🐱", "🐕", "🐸", "🦊", "🌕", "💎", "🔥", "🧊", "🦄"];
/** Display names for the whitelisted tokenized stocks (the deployments file only carries symbols). */
const QUOTE_NAMES: Record<string, string> = { NVDA: "NVIDIA", CRCL: "Circle", SPY: "S&P 500 ETF", TSLA: "Tesla", AAPL: "Apple", MSFT: "Microsoft" };

/**
 * Single-page launch form. The creator types a name and hits "Generate with AI": symbol, description and a logo are
 * filled in (all still editable, logo replaceable by upload / emoji). Standard vs tax token stays a first-class choice;
 * the tax sliders start at the platform defaults and can be dragged.
 */
export default function CreatePage() {
  const { t, connected, address, wrongChain, toggleConnect } = useApp();
  const { launch: doLaunch } = useLaunch();
  const router = useRouter();
  const qc = useQueryClient();
  const cfg = useConfig().data;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [emoji, setEmoji] = useState("🚀");
  const [logoUrl, setLogoUrl] = useState("");
  const [desc, setDesc] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");
  const [farcaster, setFarcaster] = useState("");
  const [initialBuy, setInitialBuy] = useState("");
  const [payout, setPayout] = useState("");
  const [referralPct, setReferralPct] = useState("");
  const [mode, setMode] = useState<"standard" | "tax">("standard");
  // pool quote asset: "" = USDC (default factory); a stock symbol = the stock generation's factory
  const [quoteSym, setQuoteSym] = useState("");
  const quotesQ = useQuotes();
  const [buyTaxPct, setBuyTaxPct] = useState(3);
  const [sellTaxPct, setSellTaxPct] = useState(3);
  const [marketingPct, setMarketingPct] = useState(50);
  const [marketingWallet, setMarketingWallet] = useState("");
  const [teamWallet, setTeamWallet] = useState("");
  const [busy, setBusy] = useState<null | "launch">(null);
  const [uploading, setUploading] = useState(false);
  const [ai, setAi] = useState<null | "all" | "logo">(null);
  const [aiFilled, setAiFilled] = useState<{ symbol?: boolean; desc?: boolean; logo?: boolean }>({});
  const [showSocials, setShowSocials] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const onPickFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 1024 * 1024) return toast.error("max 1 MB");
    setUploading(true);
    try {
      const { url } = await uploadLogo(file);
      setLogoUrl(url);
      setAiFilled((f) => ({ ...f, logo: false }));
      toast.success(t("create.uploaded"));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const quotaQ = useAiDraftQuota(address);

  /** AI assist: `all` fills symbol + description + logo (only fields the user has not typed into), `logo` swaps the picture only. */
  const generate = async (what: "all" | "logo", fresh = false) => {
    const nm = name.trim();
    if (nm.length < 2) return toast.error(t("create.ai.needName"));
    if (!address) return toggleConnect();
    setAi(what);
    try {
      const d = await aiTokenDraft(nm, address, fresh);
      if (!d.cached) void quotaQ.refetch();
      if (what === "all") {
        const next = { ...aiFilled };
        if (!symbol || aiFilled.symbol) { setSymbol(d.symbol); next.symbol = true; }
        if (!desc || aiFilled.desc) { setDesc(d.description); next.desc = true; }
        if (!logoUrl || aiFilled.logo) { setLogoUrl(d.logo); next.logo = true; }
        setAiFilled(next);
        toast.success(t("create.ai.done"));
      } else {
        setLogoUrl(d.logo);
        setAiFilled((f) => ({ ...f, logo: true }));
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAi(null);
    }
  };

  const me = address as Address | undefined;
  const balQ = useReadContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 8000 } });

  const fee6 = cfg ? BigInt(cfg.params.creationFee) : 0n;
  const fee = Number(fee6) / 1e6;
  const buy = parseFloat(initialBuy) || 0;
  const buy6 = (() => { try { return buy > 0 ? parseUnits(String(buy), 6) : 0n; } catch { return 0n; } })();
  // gas is paid in USDC too: a launch is ~8.4M gas (padded to 11M in useLaunch); price it at the live gas price so the
  // summary and the balance check track network congestion (mainnet day one: base fee went 20 → 170 gwei)
  const gasQ = useGasPrice({ query: { refetchInterval: 15_000 } });
  const gasWei = (gasQ.data ?? 20_000_000_000n) * 11_000_000n; // 18dp
  const gasUsd = Number(gasWei) / 1e18;
  const gas6 = gasWei / 1_000_000_000_000n; // native 18dp → USDC 6dp (same balance on Arc)
  const need6 = fee6 + buy6 + gas6;
  const balance = balQ.data ?? 0n;
  const insufficient = connected && need6 > balance;
  const startMcap = cfg ? Number(cfg.params.startMcapUsdc) / 1e6 : 5000;
  const startPrice = startMcap / SUPPLY_TOKENS;
  const logo = logoUrl.trim() ? logoUrl.trim() : `emoji:${emoji}`;
  const graduationThreshold = cfg ? Number(cfg.params.graduationThreshold) / 1e6 : 10000;
  // stock generation: the chosen quote asset and its live USDC price (the opening mcap / threshold are the same USD
  // figures, expressed in the stock at launch time by the contract)
  const quoteAsset = quoteSym ? QUOTES.find((q) => q.symbol === quoteSym) : undefined;
  const quoteLive = quoteSym ? quotesQ.data?.find((q) => q.symbol === quoteSym) : undefined;
  const quotePrice = quoteLive?.priceUsdc ? Number(quoteLive.priceUsdc) / 1e6 : 0;
  const stockOn = STOCK_LAUNCH_UI;
  const maxTaxPct = (cfg?.params.maxTaxBps ?? 1000) / 100;
  const taxed = mode === "tax";
  const buyTaxBps = taxed ? Math.round(Math.min(buyTaxPct, maxTaxPct) * 100) : 0;
  const sellTaxBps = taxed ? Math.round(Math.min(sellTaxPct, maxTaxPct) * 100) : 0;
  const marketingBps = taxed ? Math.round(marketingPct * 100) : 0;
  const payoutTrim = payout.trim();
  const payoutValid = payoutTrim === "" || isAddress(payoutTrim);
  const mkTrim = marketingWallet.trim();
  const tmTrim = teamWallet.trim();
  const mkValid = mkTrim === "" || isAddress(mkTrim);
  const tmValid = tmTrim === "" || isAddress(tmTrim);
  const taxWalletsValid = !taxed || (mkValid && tmValid);
  const addrOrZero = (s: string) => (s && isAddress(s) ? getAddress(s) : zeroAddress) as Address;
  const ready = name.trim().length > 1 && symbol.trim().length > 0;
  // AI assistant gate: wallet connected, holds ≥ creation fee, and has generations left today
  const aiLeft = quotaQ.data?.left;
  const aiNoBalance = connected && !wrongChain && balQ.data !== undefined && balance < fee6;
  const aiNoQuota = connected && aiLeft !== undefined && aiLeft <= 0;
  const aiBlocked = !connected ? t("common.connect") : wrongChain ? t(`wallet.switch.${NET}`) : aiNoBalance ? t("create.ai.needUsdc").replace("{n}", String(fee)) : aiNoQuota ? t("create.ai.noQuota").replace("{n}", String(quotaQ.data?.perDay ?? 1)) : null;

  const launch = async () => {
    if (!me) return;
    setBusy("launch");
    try {
      const res = await doLaunch(
        {
          name: name.trim(),
          symbol: symbol.trim(),
          logo,
          description: desc.trim(),
          socials: { website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim(), discord: discord.trim(), farcaster: farcaster.trim() },
          payout: addrOrZero(payoutTrim),
          buyTaxBps,
          sellTaxBps,
          marketingWallet: taxed ? addrOrZero(mkTrim) : zeroAddress,
          teamWallet: taxed ? addrOrZero(tmTrim) : zeroAddress,
          marketingBps,
          initialBuyUsdc: buy6,
          quote: quoteAsset?.address,
          referralBps: Math.round(Math.min(50, Math.max(0, parseFloat(referralPct) || 0)) * 100),
        },
        fee6,
      );
      if (!res) return;
      const tokenAddr = res.token;
      toast.success(t("tx.launched"), { description: tokenAddr });
      void qc.invalidateQueries({ queryKey: ["tokens"] });
      void qc.invalidateQueries({ queryKey: ["activity"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      setTimeout(() => router.push(tokenAddr ? `/token/${tokenAddr}` : "/"), 2500);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const aiTag = (on?: boolean) => (on ? <AiTag label={t("create.ai.filledBy")} /> : null);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("create.title")}</h1>
        <p className="mt-1 text-sm text-secondary-foreground">{t("create.subtitle")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardContent className="space-y-6 md:px-6">
            {/* 1 · name + AI */}
            <div className="space-y-2">
              <Label htmlFor="name" className="label">{t("create.name")}</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Arc Cat" className="h-11 text-base" onKeyDown={(e) => { if (e.key === "Enter") void generate("all"); }} />
                <Button size="lg" variant="glow" className="h-11 shrink-0" disabled={!!ai || name.trim().length < 2 || (connected && !wrongChain && (aiNoBalance || aiNoQuota))} onClick={() => (!connected || wrongChain ? toggleConnect() : void generate("all", aiFilled.symbol || aiFilled.desc || aiFilled.logo ? true : false))}>
                  {ai === "all" ? <RefreshCw className="animate-spin" /> : <Sparkles />}
                  {ai === "all" ? t("create.ai.working") : !connected || wrongChain ? aiBlocked : aiFilled.symbol || aiFilled.desc ? t("create.ai.regen") : t("create.ai.button")}
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("create.ai.hint")}
                {connected && !wrongChain && (aiBlocked ? <span className="ml-1 text-down">{aiBlocked}</span> : aiLeft !== undefined ? <span className="ml-1">{t("create.ai.left").replace("{n}", String(aiLeft))}</span> : null)}
              </p>
            </div>

            {/* 2 · identity (editable) */}
            <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
              <Field label={<>{t("create.symbol")}{aiTag(aiFilled.symbol)}</>} htmlFor="symbol">
                <Input id="symbol" value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); setAiFilled((f) => ({ ...f, symbol: false })); }} maxLength={10} placeholder="ACAT" className="font-mono uppercase" />
              </Field>
              <Field label={<>{t("create.description")}{aiTag(aiFilled.desc)}</>} htmlFor="desc">
                <Textarea id="desc" value={desc} onChange={(e) => { setDesc(e.target.value); setAiFilled((f) => ({ ...f, desc: false })); }} maxLength={280} rows={3} placeholder="The first cat on Arc…" className="resize-none" />
                <div className="mt-1 text-right font-mono text-[11px] text-muted-foreground">{desc.length}/280</div>
              </Field>
            </div>

            <Field label={<>{t("create.logo")}{aiTag(aiFilled.logo)}</>} hint={t("create.dropLogo")}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <label className={cn("relative flex size-28 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-dashed border-input text-[11px] text-muted-foreground hover:border-ring hover:text-foreground", (uploading || ai === "logo") && "opacity-60")}>
                  {logoUrl && /^(https?:|\/)/.test(logoUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <>
                      <ImagePlus size={20} />
                      <span className="px-2 text-center leading-tight">{uploading ? t("create.uploading") : t("create.upload")}</span>
                    </>
                  )}
                  {ai === "logo" && <span className="absolute inset-0 flex items-center justify-center bg-background/60"><RefreshCw className="animate-spin" size={18} /></span>}
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" disabled={uploading} onChange={(e) => void onPickFile(e.target.files?.[0])} />
                </label>
                <div className="flex-1 space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    <Button type="button" variant="outline" size="sm" disabled={!!ai || name.trim().length < 2 || !connected || wrongChain || aiNoBalance || aiNoQuota} onClick={() => void generate("logo", true)}><Sparkles /> {t("create.ai.regenLogo")}</Button>
                    {EMOJIS.map((e) => (
                      <Button key={e} type="button" variant={emoji === e && !logoUrl ? "default" : "secondary"} size="icon-sm" className="text-base" onClick={() => { setEmoji(e); setLogoUrl(""); setAiFilled((f) => ({ ...f, logo: false })); }}>{e}</Button>
                    ))}
                  </div>
                  <Input value={logoUrl} onChange={(e) => { setLogoUrl(e.target.value); setAiFilled((f) => ({ ...f, logo: false })); }} placeholder="https://…/logo.png" />
                </div>
              </div>
            </Field>

            <Separator />

            {/* 3 · token type */}
            <Field label={t("tax.mode")}>
              <div className="grid gap-2 sm:grid-cols-2">
                <ModeCard active={!taxed} onClick={() => setMode("standard")} title={t("tax.standard")} desc={t("tax.standardDesc")} icon={<Scale size={14} />} />
                <ModeCard active={taxed} onClick={() => setMode("tax")} title={t("tax.taxed")} desc={t("tax.taxedDesc")} icon={<Percent size={14} />} />
              </div>
              {taxed && (
                <div className="mt-3 space-y-4 rounded-lg border border-gold/40 bg-gold/5 p-3">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Range label={t("tax.buy")} value={buyTaxPct} max={maxTaxPct} onChange={setBuyTaxPct} />
                    <Range label={t("tax.sell")} value={sellTaxPct} max={maxTaxPct} onChange={setSellTaxPct} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("tax.maxHint").replace("{n}", String(maxTaxPct))}</p>
                  <div className="space-y-3">
                    <div className="label">{t("tax.alloc")}</div>
                    <Range label={`${t("tax.marketing")} ${marketingPct}% · ${t("tax.team")} ${100 - marketingPct}%`} value={marketingPct} max={100} step={5} onChange={setMarketingPct} showValue={false} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="mk" className="label">{t("tax.marketingWallet")} <span className="font-mono text-gold">{marketingPct}%</span></Label>
                        <Input id="mk" value={marketingWallet} onChange={(e) => setMarketingWallet(e.target.value)} placeholder={address ?? "0x…"} className={cn("mt-1 font-mono", !mkValid && "border-down")} />
                        {!mkValid && <p className="mt-1 text-[11px] text-down">{t("tax.walletInvalid")}</p>}
                      </div>
                      <div>
                        <Label htmlFor="tm" className="label">{t("tax.teamWallet")} <span className="font-mono text-gold">{100 - marketingPct}%</span></Label>
                        <Input id="tm" value={teamWallet} onChange={(e) => setTeamWallet(e.target.value)} placeholder={address ?? "0x…"} className={cn("mt-1 font-mono", !tmValid && "border-down")} />
                        {!tmValid && <p className="mt-1 text-[11px] text-down">{t("tax.walletInvalid")}</p>}
                      </div>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{t("tax.allocHint")}</p>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{t("tax.sellNote")}</p>
                  <div className="flex items-center gap-2 rounded-md bg-gold/15 px-2 py-1.5 text-xs font-medium text-gold"><Lock size={12} /> {t("tax.immutable")}</div>
                </div>
              )}
            </Field>

            {/* 3b · pool quote asset (stock generation) */}
            {stockOn && (
              <Field label={t("create.quote")} hint={t("create.quoteHint")}>
                <div className="grid gap-2 sm:grid-cols-3">
                  <ModeCard active={!quoteSym} onClick={() => setQuoteSym("")} title="USDC" desc={t("create.quoteUsdcDesc")} icon={<Scale size={14} />} />
                  {QUOTES.map((q) => {
                    const live = quotesQ.data?.find((x) => x.symbol === q.symbol);
                    const px = live?.priceUsdc ? Number(live.priceUsdc) / 1e6 : 0;
                    return (
                      <ModeCard
                        key={q.address}
                        active={quoteSym === q.symbol}
                        onClick={() => setQuoteSym(q.symbol)}
                        title={q.symbol}
                        desc={`${QUOTE_NAMES[q.symbol] ?? q.symbol}${px ? ` · ${fmtUsd(px)}` : ""}`}
                        icon={<LineChart size={14} />}
                      />
                    );
                  })}
                </div>
                {quoteSym && (
                  <div className="mt-3 space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    <p>{t("create.quoteNote").replace(/\{q\}/g, quoteSym)}</p>
                    <p>{t("create.quoteRisk").replace(/\{q\}/g, quoteSym)}</p>
                  </div>
                )}
              </Field>
            )}

            {/* 4 · fixed launch params */}
            <Field label={t("create.launchParams")} hint={quoteSym ? t("create.startMcapHintQuote").replace(/\{q\}/g, quoteSym) : t("create.startMcapHint")}>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <Pill k={t("create.startMcap")} v={fmtUsd(startMcap, { compact: true })} badge={t("create.fairLaunch")} sub={quotePrice ? `≈ ${fmtNum(startMcap / quotePrice, 2)} ${quoteSym}` : undefined} />
                <Pill k={t("common.price")} v={fmtUsd(startPrice)} sub={quotePrice ? `≈ ${(startPrice / quotePrice).toExponential(2)} ${quoteSym}` : undefined} />
                <Pill k={t("token.threshold")} v={`${fmtUsd(graduationThreshold, { compact: true })}`} sub={quotePrice ? `≈ ${fmtNum(graduationThreshold / quotePrice, 2)} ${quoteSym}` : undefined} />
              </div>
            </Field>

            {/* 5 · optional: socials / payout / first buy */}
            <Collapsible open={showSocials} onToggle={() => setShowSocials((v) => !v)} title={t("create.socials")}>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t("create.website")} htmlFor="web"><Input id="web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" /></Field>
                <Field label={t("create.twitter")} htmlFor="x"><Input id="x" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/…" /></Field>
                <Field label={t("create.telegram")} htmlFor="tg"><Input id="tg" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/…" /></Field>
                <Field label="Discord" htmlFor="dc"><Input id="dc" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.gg/…" /></Field>
                <Field label="Farcaster" htmlFor="fc"><Input id="fc" value={farcaster} onChange={(e) => setFarcaster(e.target.value)} placeholder="https://warpcast.com/…" /></Field>
              </div>
            </Collapsible>

            <Collapsible open={showAdvanced} onToggle={() => setShowAdvanced((v) => !v)} title={t("create.advanced")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("create.initialBuy")} hint={t("create.initialBuyHint")} htmlFor="buy">
                  <div className="flex items-center gap-2 rounded-lg border border-input bg-muted px-3 py-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
                    <input id="buy" type="number" inputMode="decimal" value={initialBuy} onChange={(e) => setInitialBuy(e.target.value)} placeholder="0.00" className="min-w-0 flex-1 bg-transparent font-mono text-lg outline-none tabular placeholder:text-muted-foreground" />
                    <span className="rounded-md bg-accent px-2 py-1 font-mono text-xs">USDC</span>
                  </div>
                  {connected && <div className="mt-1 text-right font-mono text-[11px] text-muted-foreground">{t("common.balance")}: {fmtUsd(Number(formatUnits(balance, 6)))}</div>}
                </Field>
                <Field label={t("create.payout")} hint={t("create.payoutHint")} htmlFor="payout">
                  <Input id="payout" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder={address ?? "0x…"} className={cn("font-mono", !payoutValid && "border-down")} />
                  {!payoutValid && <p className="mt-1 text-[11px] text-down">{t("create.payoutInvalid")}</p>}
                </Field>
                <Field label={t("create.referral")} hint={t("create.referralHint")} htmlFor="referral">
                  <div className="flex items-center gap-2 rounded-lg border border-input bg-muted px-3 py-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
                    <input id="referral" type="number" inputMode="decimal" min={0} max={50} step={1} value={referralPct} onChange={(e) => setReferralPct(e.target.value)} placeholder="0" className="min-w-0 flex-1 bg-transparent font-mono text-lg outline-none tabular placeholder:text-muted-foreground" />
                    <span className="rounded-md bg-accent px-2 py-1 font-mono text-xs">%</span>
                  </div>
                </Field>
              </div>
            </Collapsible>

            <ul className="grid gap-2 text-xs text-secondary-foreground sm:grid-cols-3">
              <Li icon={<Lock size={13} />}>{t("token.lpLocked")}</Li>
              <Li icon={<ShieldCheck size={13} />}>{t("token.protectionActive")}</Li>
              <Li icon={<Zap size={13} />}>{t("common.finality")} · {t("common.usdcSettled")}</Li>
            </ul>
          </CardContent>
        </Card>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card size="sm">
            <CardHeader><CardTitle className="label">{t("create.preview")}</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-start gap-3">
                <TokenAvatar logo={logo} symbol={symbol || "TKN"} seed={name + symbol} size={48} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{name || "Token name"}</span>
                    <span className="font-mono text-xs text-muted-foreground">${symbol || "TKN"}</span>
                    {taxed && <Badge variant="gold"><Percent /> {t("tax.badge").replace("{b}", String(buyTaxBps / 100)).replace("{s}", String(sellTaxBps / 100))}</Badge>}
                  </div>
                  <p className="mt-0.5 line-clamp-3 text-xs text-secondary-foreground">{desc || "…"}</p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-semibold tabular">{fmtUsd(startPrice)}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtUsd(startMcap, { compact: true })} mcap</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader><CardTitle className="label">{t("create.summary")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("create.fee")}</span>
                <span className="flex items-center gap-2 font-mono tabular">{fee > 0 ? fmtUsd(fee) : t("create.feeFree")} <Badge variant="secondary"><Lock /> {t("create.feeFixed")}</Badge></span>
              </div>
              {quoteSym && (
                <div className="flex items-center justify-between"><span className="text-muted-foreground">{t("create.quote")}</span><Badge variant="secondary"><LineChart /> {quoteSym}</Badge></div>
              )}
              <div className="flex items-center justify-between"><span className="text-muted-foreground">{t("create.initialBuy")}</span><span className="font-mono tabular">{fmtUsd(buy)}</span></div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Gas (USDC)</span>
                <span className={cn("font-mono tabular", gasUsd > 1 && "text-gold")} title={gasQ.data ? `${(Number(gasQ.data) / 1e9).toFixed(0)} gwei × 11M gas` : undefined}>~{fmtUsd(gasUsd)}</span>
              </div>
              {gasUsd > 1 && <div className="text-[11px] text-gold">{t("create.gasHigh")}</div>}
              <Separator />
              <div className="flex items-center justify-between font-semibold"><span>{t("common.total")}</span><span className="font-mono tabular">{fmtUsd(fee + buy + gasUsd)}</span></div>
              {insufficient && (
                <div className="text-xs text-down">
                  {t("tx.insufficient")} · {IS_TESTNET ? <a className="underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">{t("tx.faucet")}</a> : <Link className="underline" href="/tools?tab=bridge">{t("tx.bridge")}</Link>}
                </div>
              )}
              {/* launch CTA lives in the (sticky) summary column: under the total on desktop, at the very end on phones (boss 9.16) */}
              <Button size="xl" variant="glow" className="mt-2 w-full" onClick={!connected || wrongChain ? toggleConnect : launch} disabled={connected && !wrongChain && (insufficient || !!busy || !ready || !payoutValid || !taxWalletsValid)}>
                <Rocket />
                {!connected ? t("common.connect") : wrongChain ? t(`wallet.switch.${NET}`) : insufficient ? t("tx.insufficient") : busy === "launch" ? t("create.step.launch") : t("create.launchBtn")}
              </Button>
            </CardContent>
          </Card>

          <Card size="sm" className="bg-gradient-to-br from-up/15 to-card ring-up/30">
            <CardHeader>
              <CardTitle className="label text-up!">{t("create.youGet")}</CardTitle>
              <CardDescription><span className="font-mono text-3xl font-bold text-up">{(cfg?.params.creatorShareBps ?? 7500) / 100}%</span></CardDescription>
            </CardHeader>
            <CardContent className="text-xs text-secondary-foreground">{t("create.youGetDesc")}</CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function AiTag({ label }: { label: string }) {
  return <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-normal text-primary"><Sparkles size={10} /> {label}</span>;
}

function Field({ label, hint, htmlFor, children }: { label: React.ReactNode; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="label">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Collapsible({ open, onToggle, title, children }: { open: boolean; onToggle: () => void; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium hover:bg-muted/60">
        {title}
        <ChevronDown size={16} className={cn("text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}

function Pill({ k, v, badge, sub }: { k: string; v: string; badge?: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2">
      <div className="text-muted-foreground">{k}</div>
      <div className="mt-0.5 flex items-center gap-1.5 font-mono font-semibold tabular">{v}{badge && <Badge variant="up" className="px-1.5 py-0 text-[10px]">{badge}</Badge>}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground tabular">{sub}</div>}
    </div>
  );
}

function ModeCard({ active, onClick, title, desc, icon }: { active: boolean; onClick: () => void; title: string; desc: string; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("rounded-lg border p-3 text-left transition-colors", active ? "border-primary bg-primary/10 ring-2 ring-primary/30" : "border-input bg-muted hover:border-ring")}>
      <div className="flex items-center gap-2 text-sm font-semibold"><span className={active ? "text-primary" : "text-muted-foreground"}>{icon}</span>{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
    </button>
  );
}

function Range({ label, value, max, step = 0.5, onChange, showValue = true }: { label: string; value: number; max: number; step?: number; onChange: (v: number) => void; showValue?: boolean }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        {showValue && <span className="font-mono font-semibold text-gold tabular">{value}%</span>}
      </div>
      <input type="range" min={0} max={max} step={step} value={Math.min(value, max)} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--gold)]" />
    </div>
  );
}

function Li({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 rounded-lg bg-muted p-2.5">
      <span className="mt-0.5 text-primary">{icon}</span>
      <span>{children}</span>
    </li>
  );
}
