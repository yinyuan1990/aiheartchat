"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, LocalAccount } from "viem";
import { ArrowDown, ArrowUp, CaretDown, CaretRight, ChatsCircle, CheckCircle, Megaphone, Robot, Sparkle, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { canCoinGroup, canPerpCall, openCoinGroup, storeRead, storeWrite } from "@/lib/wallet/native";
import { parseFollow, postPerpCall, type Follow, type PerpCallCard } from "@/lib/wallet/perp-call";
import { HL_BUILDER, account, agentActive, agentExtraKey, approveAgent, approveBuilder, assets, MARGIN_SAFETY, TAKER_FEE, builderApproved, cancelOrder, closePosition, formatPx, trades, newAgent, openOrders, openPosition, parseAgent, setLeverage, type HlAccount, type HlAsset, type HlOrder, type HlPosition } from "@/lib/wallet/hl";
import { AI_CONFIG_KEY, analyze, parseAiConfig, type AiConfig, type AiResult } from "@/lib/wallet/ai-trade";
import { useVault } from "@/components/wallet/wallet-context";
import { AI_GRADIENT, AiCard, AiSettingsSheet, CoinPicker, DIR, DepositSheet, RiskGate, Spinner, WithdrawSheet, px, sUsd, usd } from "@/components/wallet/perp-parts";
import { BottomNav, BottomSheet, GhostButton, IconButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";
import { HostedCard } from "@/components/wallet/aibot-parts";
import { PerpChart, type ChartLine } from "@/components/wallet/perp-chart";

type Sheet = null | "risk" | "deposit" | "withdraw" | "ai" | "coin" | "confirm" | "close" | "call";
type LogItem = { at: number; coin: string; action: string; price: number; confidence: number; summary: string };
const QUICK = ["BTC", "ETH", "SOL", "HYPE"];
const noSubscribe = () => () => {};
const LOG_KEY = "perp.aiLog";

/** 「AI 合约」: Hyperliquid perps from the wallet; the AI (user's own key) suggests, the user confirms every order. */
export default function PerpPage() {
  const vault = useVault();
  const qc = useQueryClient();
  const user = vault.active?.address as Address | undefined;
  const main = () => vault.account() as LocalAccount;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [ver, setVer] = useState(0);
  const [busy, setBusy] = useState("");

  // risk notice once; last coin
  const [coin, setCoinState] = useState("BTC");
  const [follow, setFollow] = useState<Follow | null>(null);
  useEffect(() => {
    void storeRead("perp.risk").then((v) => v !== "1" && setSheet("risk"));
    // 跟单 link from a chat card: the caller's setup, margin left to the follower
    const f = parseFollow(new URLSearchParams(location.search).get("follow"));
    if (f) {
      setFollow(f);
      setCoinState(f.coin);
      setSide(f.side);
      setType("market");
      setLev(f.lev);
      setTp(f.tp ? String(f.tp) : "");
      setSl(f.sl ? String(f.sl) : "");
    } else void storeRead("perp.coin").then((v) => v && setCoinState(v));
    void storeRead(LOG_KEY).then((v) => {
      try {
        if (v) setLog(JSON.parse(v) as LogItem[]);
      } catch {}
    });
  }, []);
  const setCoin = (c: string) => {
    if (c !== coin) {
      // prices typed for the previous coin mean nothing for this one
      setLimitPx("");
      setTp("");
      setSl("");
      setFollow(null);
    }
    setCoinState(c);
    void storeWrite("perp.coin", c);
  };

  const list = useQuery({ queryKey: ["hl", "assets"], queryFn: () => assets(2_000), refetchInterval: 5_000 });
  const asset = list.data?.find((a) => a.name === coin);
  const acctQ = useQuery({ queryKey: ["hl", "acct", user], queryFn: () => account(user!), enabled: !!user, refetchInterval: 5_000 });
  const ordersQ = useQuery({ queryKey: ["hl", "orders", user], queryFn: () => openOrders(user!), enabled: !!user, refetchInterval: 8_000 });
  const tradesQ = useQuery({ queryKey: ["hl", "trades", user], queryFn: () => trades(user!), enabled: !!user, refetchInterval: 30_000 });
  const lastTrade = tradesQ.data?.[0];
  const acct = acctQ.data;
  const available = acct?.available ?? 0;
  const funded = !!acct && (acct.equity > 0 || acct.positions.length > 0);

  // agent key (in the vault) and whether Hyperliquid still knows it
  const agent = useMemo(() => (user ? parseAgent(vault.extra(agentExtraKey(user))) : null), [user, ver, vault]);
  const agentQ = useQuery({ queryKey: ["hl", "agent", user, agent?.address], queryFn: () => (agent && user ? agentActive(user, agent) : Promise.resolve(false)), enabled: !!user, staleTime: 60_000 });
  const builderQ = useQuery({ queryKey: ["hl", "builder", user], queryFn: () => builderApproved(user!), enabled: !!user && !!HL_BUILDER });
  const ready = !!agent && agentQ.data === true && (!HL_BUILDER || builderQ.data === true);
  const aiCfg = useMemo(() => parseAiConfig(vault.extra(AI_CONFIG_KEY)), [ver, vault]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["hl"] });

  const authorize = async () => {
    if (!user) return;
    setBusy("auth");
    try {
      if (!(agent && agentQ.data)) {
        const a = newAgent();
        await approveAgent(main(), a);
        await vault.saveExtra(agentExtraKey(user), JSON.stringify(a));
        setVer((v) => v + 1);
      }
      if (HL_BUILDER && !(await builderApproved(user))) await approveBuilder(main());
      toast.success("已开通：下单由这台手机上的交易钥匙签名，它只能交易、不能提现");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  // ---------- order form ----------
  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState("");
  const [lev, setLev] = useState(3);
  const [margin, setMargin] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const maxLev = asset?.maxLeverage ?? 20;
  const levUsed = Math.min(lev, maxLev);
  const refPx = type === "limit" && Number(limitPx) > 0 ? Number(limitPx) : (asset?.mark ?? 0);
  const m = Number(margin) || 0;
  // Hyperliquid checks margin at the higher of the order price and the mark, and wants the opening fee on top
  const marginPx = Math.max(refPx, asset?.mark ?? 0);
  const size = marginPx ? (m * levUsed) / marginPx : 0;
  const notional = size * refPx;
  const usable = Math.floor(((available * MARGIN_SAFETY) / (1 + levUsed * TAKER_FEE)) * 100) / 100;
  const tpN = Number(tp) || 0, slN = Number(sl) || 0;
  const isLong = side === "long";
  // isolated margin: maintenance margin is half the initial margin at max leverage
  const liqEst = refPx && m ? refPx * (isLong ? 1 - 1 / levUsed + 0.5 / maxLev : 1 + 1 / levUsed - 0.5 / maxLev) : 0;
  const problem = !m
    ? null
    : m > usable + 1e-9
      ? m > available + 1e-9
        ? "可用余额不够"
        : `要留一点给开仓手续费和价格变动，${levUsed} 倍下保证金最多 ${usd(usable)}`
      : notional < 10
        ? "每笔至少 10 美元（保证金 × 杠杆）"
        : tpN && (isLong ? tpN <= refPx : tpN >= refPx)
          ? "止盈价要在开仓价的" + (isLong ? "上方" : "下方")
          : tpN && Math.abs(tpN / refPx - 1) < TAKER_FEE * 2.5
            ? `止盈离开仓价太近（不到 ${(TAKER_FEE * 250).toFixed(2)}%），一碰就平，扣掉开平仓手续费是亏的`
          : slN && (isLong ? slN >= refPx : slN <= refPx)
            ? "止损价要在开仓价的" + (isLong ? "下方" : "上方")
            : slN && liqEst && (isLong ? slN <= liqEst : slN >= liqEst)
              ? "止损价在强平价之外，会先被强平"
              : null;
  const fee = notional * TAKER_FEE * 2;
  /** what the position makes / loses if it is closed at `price`: price move × size, ROE on the margin, net of both fees */
  const outcome = (price: number) => {
    if (!price || !size || !m) return null;
    const pnl = (isLong ? price - refPx : refPx - price) * size;
    return { pnl, roe: (pnl / m) * 100, net: pnl - notional * TAKER_FEE - price * size * TAKER_FEE };
  };
  const tpOut = outcome(tpN);
  const slOut = outcome(slN);
  /** the price at which the margin gains (+) / loses (−) `roe` percent at this leverage */
  const priceAtRoe = (roe: number) => (asset && refPx ? formatPx(refPx * (1 + ((isLong ? 1 : -1) * roe) / 100 / levUsed), asset.szDecimals) : "");
  const beyondLiq = (roe: number) => {
    const p = Number(priceAtRoe(-roe));
    return !p || !liqEst || (isLong ? p <= liqEst * 1.002 : p >= liqEst * 0.998);
  };
  const hints = [
    levUsed >= 20 && liqEst ? `${levUsed} 倍杠杆：价格反向波动约 ${(Math.abs(liqEst / refPx - 1) * 100).toFixed(2)}% 就会被强平，这笔保证金全亏` : "",
    slN && Math.abs(slN / refPx - 1) < 0.002 ? "止损离开仓价不到 0.2%，正常波动就可能被打掉" : "",
    m && fee > m * 0.05 ? `开仓加平仓手续费约 ${usd(fee)}，占保证金 ${((fee / m) * 100).toFixed(0)}%` : "",
  ].filter(Boolean);

  const place = async () => {
    if (!asset || !agent) return;
    setBusy("order");
    try {
      await setLeverage(agent, asset, levUsed, false);
      await openPosition(agent, { asset, isBuy: isLong, size, limitPx: type === "limit" ? Number(limitPx) : undefined, tp: tpN || undefined, sl: slN || undefined });
      const placed: PerpCallCard = { coin: asset.name, side, lev: levUsed, entry: refPx, orderType: type, tp: tpN || null, sl: slN || null };
      toast.success(type === "market" ? `已${isLong ? "开多" : "开空"} ${asset.name}` : "限价单已挂出", canCall ? { duration: 10_000, action: { label: "喊单到群", onClick: () => callFor(asset.name, placed) } } : undefined);
      setSheet(null);
      setMargin("");
      setTp("");
      setSl("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  // ---------- 喊单 into the perp's group chat ----------
  const canCall = useSyncExternalStore(noSubscribe, canPerpCall, () => false);
  const canGroup = useSyncExternalStore(noSubscribe, canCoinGroup, () => false);
  const [callCard, setCallCard] = useState<PerpCallCard | null>(null);
  const [callNote, setCallNote] = useState("");
  /** the live position (entry, leverage, TP / SL orders) when there is one, else what was just ordered */
  const callFor = (c: string, placed?: PerpCallCard) => {
    const pos = qc.getQueryData<HlAccount>(["hl", "acct", user])?.positions.find((x) => x.coin === c);
    const orders = qc.getQueryData<HlOrder[]>(["hl", "orders", user]) ?? [];
    const trig = (k: "tp" | "sl") => orders.find((o) => o.coin === c && o.trigger === k)?.triggerPx ?? null;
    const card: PerpCallCard | undefined = pos ? { coin: c, side: pos.side, lev: pos.leverage, entry: pos.entry, orderType: "market", tp: trig("tp"), sl: trig("sl") } : placed;
    if (!card) return void toast.error(`你现在没有 ${c} 仓位，开仓后才能喊单`);
    setCallCard(card);
    setCallNote("");
    setSheet("call");
  };
  const sendCall = async () => {
    if (!callCard) return;
    setBusy("call");
    try {
      await postPerpCall(main(), { ...callCard, note: callNote.trim() });
      toast.success(`已喊单到 ${callCard.coin} 合约群`);
      setSheet(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const [closing, setClosing] = useState<HlPosition | null>(null);
  const doClose = async () => {
    const pos = closing;
    const a = list.data?.find((x) => x.name === pos?.coin);
    if (!pos || !a || !agent) return;
    setBusy("close");
    try {
      await closePosition(agent, a, pos);
      toast.success(`已平掉 ${pos.coin}`);
      setSheet(null);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const cancel = async (c: string, oid: number) => {
    const a = list.data?.find((x) => x.name === c);
    if (!a || !agent) return;
    try {
      await cancelOrder(agent, a, oid);
      toast.success("已撤单");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // ---------- AI ----------
  const [ai, setAi] = useState<AiResult | null>(null);
  const [log, setLog] = useState<LogItem[]>([]);
  const runAi = async () => {
    if (!asset) return;
    if (!aiCfg) return setSheet("ai");
    setBusy("ai");
    try {
      const r = await analyze(aiCfg, asset.name, user);
      setAi(r);
      const next = [{ at: r.at, coin: r.coin, action: r.decision.action, price: r.price, confidence: r.decision.confidence, summary: r.decision.summary }, ...log].slice(0, 20);
      setLog(next);
      void storeWrite(LOG_KEY, JSON.stringify(next));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const applyAi = () => {
    if (!ai) return;
    const d = ai.decision;
    if (d.action === "close") {
      const p = acct?.positions.find((x) => x.coin === ai.coin);
      if (p) {
        setClosing(p);
        setSheet("close");
      }
      return;
    }
    if (d.action !== "long" && d.action !== "short") return;
    setSide(d.action);
    setLev(d.leverage);
    setType(d.entry ? "limit" : "market");
    setLimitPx(d.entry ? String(d.entry) : "");
    setMargin((Math.floor(usable * d.sizePct) / 100).toFixed(2));
    setTp(d.takeProfit ? String(d.takeProfit) : "");
    setSl(d.stopLoss ? String(d.stopLoss) : "");
    document.getElementById("order")?.scrollIntoView({ behavior: "smooth", block: "start" });
    toast.info("已按 AI 建议填好，检查一下再下单");
  };
  const saveAi = async (c: AiConfig) => {
    await vault.saveExtra(AI_CONFIG_KEY, JSON.stringify(c));
    setVer((v) => v + 1);
    setSheet(null);
    toast.success("AI 设置已保存");
  };

  const myOrders = ordersQ.data ?? [];
  const [live, setLive] = useState<{ coin: string; px: number } | null>(null);
  const setLivePx = (px: number) => setLive({ coin, px });
  const shownPx = live?.coin === coin ? live.px : asset?.mark;
  const ch = asset && asset.prevDay && shownPx ? (shownPx / asset.prevDay - 1) * 100 : 0;
  const myPos = acct?.positions.find((p) => p.coin === coin);
  const chartLines: ChartLine[] = [
    ...(myPos ? [{ price: myPos.entry, color: "#3b82f6", title: "开仓" }, { price: myPos.liq ?? 0, color: "#f59e0b", title: "强平" }] : []),
    ...myOrders.filter((o) => o.coin === coin && o.trigger).map((o) => ({ price: o.triggerPx ?? 0, color: o.trigger === "tp" ? "#16a34a" : "#dc2626", title: o.trigger === "tp" ? "止盈" : "止损" })),
  ];

  return (
    <WalletFrame>
      <TopBar
        title="AI 合约"
        back="/wallet/token"
        right={
          <IconButton label="AI 设置" onClick={() => setSheet("ai")}>
            <Robot size={21} weight={aiCfg ? "fill" : "regular"} />
          </IconButton>
        }
      />
      <div className="flex-1 space-y-3 px-4 pb-4">
        {/* account */}
        <section className="rounded-[24px] bg-[#0d0d0f] p-4 text-white dark:bg-[#17171c]">
          <div className="flex items-center justify-between text-[12px] text-white/60">
            <span>Hyperliquid 合约账户</span>
            {acct && <span>{acct.unified ? "统一账户" : "标准账户"}</span>}
          </div>
          <div className="mt-1 font-mono text-[30px] font-semibold">{acct ? usd(acct.equity) : "…"}</div>
          <div className="mt-1 flex gap-4 text-[12px] text-white/60">
            <span>可用 {usd(available)}</span>
            {acct && acct.positions.length > 0 && <span className={acct.upnl >= 0 ? "text-[#4fd1c5]" : "text-[#ff8a80]"}>浮盈 {sUsd(acct.upnl)}</span>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setSheet("deposit")} className="flex h-10 items-center justify-center gap-1 rounded-xl bg-white text-[14px] font-semibold text-black">
              <ArrowDown size={16} weight="bold" />
              充值
            </button>
            <button type="button" disabled={!funded} onClick={() => setSheet("withdraw")} className="flex h-10 items-center justify-center gap-1 rounded-xl bg-white/12 text-[14px] font-semibold disabled:opacity-40">
              <ArrowUp size={16} weight="bold" />
              提现
            </button>
          </div>
        </section>

        {/* onboarding */}
        {!ready && (
          <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
            <div className="text-[15px] font-semibold">开通合约交易</div>
            <Step n={1} done={funded} title="充值 USDC" sub="从钱包的 Arbitrum USDC 转入，最少 5 USDC">
              {!funded && <SmallBtn onClick={() => setSheet("deposit")}>去充值</SmallBtn>}
            </Step>
            <Step n={2} done={!!agent && agentQ.data === true && (!HL_BUILDER || builderQ.data === true)} title="授权交易钥匙" sub={`主钱包签名一次，授权这台手机上的交易钥匙下单（${HL_BUILDER ? "并同意 0.05% 平台手续费，" : ""}不能提现，180 天有效）`}>
              {funded && <SmallBtn disabled={busy === "auth"} onClick={() => void authorize()}>{busy === "auth" ? "签名中…" : agent && agentQ.data === false ? "重新授权" : "授权"}</SmallBtn>}
            </Step>
          </section>
        )}

        {/* market */}
        <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSheet("coin")} className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[20px] font-bold">
              <span className="truncate">{coin}-USD</span>
              <CaretDown size={14} weight="bold" className="shrink-0 text-muted-foreground" />
            </button>
            <span className="shrink-0 whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">最高 {maxLev}x</span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-right">
              <span className="block font-mono text-[18px] font-semibold">{shownPx ? px(shownPx) : "…"}</span>
              <span className={cn("block font-mono text-[12px]", ch >= 0 ? "text-up" : "text-down")}>
                {ch >= 0 ? "+" : ""}
                {ch.toFixed(2)}%
              </span>
            </span>
          </div>
          <PerpChart coin={coin} lines={chartLines} onPrice={setLivePx} className="mt-3 -mx-1" />
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <span>
              资金费 <b className="font-mono text-foreground">{asset ? (asset.funding * 100).toFixed(4) : "…"}%</b>/时
            </span>
            <span>
              持仓 <b className="font-mono text-foreground">{asset ? usd(asset.oi / 1e6, 0) : "…"}M</b>
            </span>
            <span>
              24h 量 <b className="font-mono text-foreground">{asset ? usd(asset.volume / 1e6, 0) : "…"}M</b>
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            {QUICK.map((c) => (
              <button key={c} type="button" onClick={() => setCoin(c)} className={cn("h-8 rounded-full px-3 text-[12px] font-semibold ring-1", c === coin ? "bg-foreground text-background ring-foreground" : "ring-border")}>
                {c}
              </button>
            ))}
          </div>
          {canGroup && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => openCoinGroup({ chain: "hl", address: coin, symbol: coin })} className="flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-muted text-[14px] font-semibold">
                <ChatsCircle size={17} weight="fill" />
                {coin} 合约群
              </button>
              <button type="button" onClick={() => (canCall ? callFor(coin) : toast.info("喊单要更新到最新版心之音 App"))} className="flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[#7c3aed]/12 text-[14px] font-semibold text-[#6d28d9] dark:text-[#c4b5fd]">
                <Megaphone size={17} weight="fill" />
                喊单
              </button>
            </div>
          )}
        </section>

        {user && <HostedCard main={main} user={user} list={list.data ?? []} aiCfg={aiCfg} funded={funded} onNeedAi={() => setSheet("ai")} />}

        {/* AI, manual: one analysis, the user confirms */}
        <button type="button" disabled={!asset || busy === "ai"} onClick={() => void runAi()} style={{ background: AI_GRADIENT }} className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[16px] font-semibold text-white disabled:opacity-60">
          {busy === "ai" ? <Spinner /> : <Sparkle size={20} weight="fill" />}
          {busy === "ai" ? "AI 正在分析行情…" : aiCfg ? `手动：让 AI 分析一次 ${coin}` : "设置 AI（用你自己的大模型 key）"}
        </button>
        {ai && <AiCard r={ai} onApply={ready && (ai.decision.action === "long" || ai.decision.action === "short" || ai.decision.action === "close") ? applyAi : undefined} onClose={() => setAi(null)} />}

        {/* order */}
        <section id="order" className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          {follow && follow.coin === coin && (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-[#7c3aed]/10 px-3 py-2 text-[12px] leading-5">
              <Megaphone size={16} weight="fill" className="mt-0.5 shrink-0 text-[#6d28d9]" />
              <span className="flex-1">
                跟单{follow.name ? ` ${follow.name}` : ""}：{follow.side === "long" ? "做多" : "做空"} {follow.coin} {follow.lev}x
                {follow.entry ? `，喊单开仓价 ${px(follow.entry)}` : ""}。方向、杠杆、止盈止损已按喊单填好，保证金你自己定，确认后才下单。
              </span>
              <button type="button" aria-label="不跟了" onClick={() => setFollow(null)} className="text-muted-foreground">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1">
            {(["long", "short"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSide(s)} className={cn("h-10 rounded-xl text-[15px] font-semibold", side === s ? (s === "long" ? "bg-up text-white" : "bg-down text-white") : "text-muted-foreground")}>
                {s === "long" ? "开多（看涨）" : "开空（看跌）"}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-[13px]">
            {(["market", "limit"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setType(t)} className={cn("font-semibold", type === t ? "text-foreground" : "text-muted-foreground")}>
                {t === "market" ? "市价" : "限价"}
              </button>
            ))}
          </div>
          {type === "limit" && <Field label="价格" value={limitPx} onChange={setLimitPx} unit="USD" placeholder={asset ? px(asset.mark) : ""} />}
          <Field label="保证金" value={margin} onChange={setMargin} unit="USDC" placeholder="0" />
          <div className="mt-2 grid grid-cols-4 gap-2">
            {[0.1, 0.25, 0.5, 1].map((p) => (
              <button key={p} type="button" onClick={() => setMargin((Math.floor(usable * p * 100) / 100).toString())} className="h-8 rounded-lg bg-muted text-[12px] font-medium">
                {p === 1 ? "全部" : `${p * 100}%`}
              </button>
            ))}
          </div>
          <label className="mt-3 block">
            <span className="flex justify-between text-[13px]">
              <span className="text-muted-foreground">杠杆（逐仓）</span>
              <span className="font-mono font-semibold">{levUsed}x</span>
            </span>
            <input type="range" min={1} max={maxLev} value={levUsed} onChange={(e) => setLev(Number(e.target.value))} className="mt-1 w-full accent-foreground" />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <Field label="止盈价（选填）" value={tp} onChange={setTp} unit="" placeholder="—" small sub={tpOut && <Outcome o={tpOut} />} />
              <RoeChips values={[25, 50, 100]} sign="+" disabled={!m || !asset} onPick={(r) => setTp(priceAtRoe(r))} />
            </div>
            <div>
              <Field label="止损价（选填）" value={sl} onChange={setSl} unit="" placeholder="—" small sub={slOut && <Outcome o={slOut} />} />
              <RoeChips values={[10, 25, 50]} sign="-" disabled={!m || !asset} isOff={beyondLiq} onPick={(r) => setSl(priceAtRoe(-r))} />
            </div>
          </div>
          {m > 0 && <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">按钮按保证金的收益率算价格：{levUsed} 倍下价格每动 1%，保证金盈亏 {levUsed}%。灰掉的止损档位已经超过强平价。</p>}
          <div className="mt-3 space-y-1 rounded-xl bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
            <Line k="仓位价值" v={notional ? usd(notional) : "—"} />
            <Line k="数量" v={size ? `${size.toPrecision(4)} ${coin}` : "—"} />
            <Line k="预估强平价" v={liqEst ? px(liqEst) : "—"} />
            <Line k="最多亏损" v={m ? `${usd(m)}（这笔保证金）` : "—"} />
            <Line k="手续费（开 + 平，约）" v={notional ? usd(fee) : "—"} />
          </div>
          {problem && <div className="mt-2 text-[12px] text-down">{problem}</div>}
          {!problem && hints.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12px] leading-5 text-[#b45309]">
              {hints.map((h) => (
                <li key={h}>· {h}</li>
              ))}
            </ul>
          )}
          <PrimaryButton className="mt-3" tone={isLong ? "up" : "down"} disabled={!ready || !m || !!problem || !asset} onClick={() => setSheet("confirm")}>
            {!ready ? "先完成上面的开通步骤" : `${isLong ? "开多" : "开空"} ${coin}`}
          </PrimaryButton>
        </section>

        {/* positions */}
        {acct && acct.positions.length > 0 && (
          <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
            <div className="mb-2 text-[15px] font-semibold">持仓</div>
            <ul className="space-y-3">
              {acct.positions.map((p) => {
                const mark = list.data?.find((a) => a.name === p.coin)?.mark;
                return (
                  <li key={p.coin} className="rounded-2xl bg-muted/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold">{p.coin}</span>
                      <span className={cn("shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold", p.side === "long" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                        {p.side === "long" ? "多" : "空"} {p.leverage}x {p.cross ? "全仓" : "逐仓"}
                      </span>
                      <span className={cn("ml-auto font-mono text-[14px] font-semibold", p.upnl >= 0 ? "text-up" : "text-down")}>
                        {sUsd(p.upnl)} ({(p.roe * 100).toFixed(1)}%)
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1 text-[11px] text-muted-foreground">
                      <span>数量<br /><b className="font-mono text-foreground">{p.size}</b></span>
                      <span>开仓<br /><b className="font-mono text-foreground">{px(p.entry)}</b></span>
                      <span>标记<br /><b className="font-mono text-foreground">{mark ? px(mark) : "—"}</b></span>
                      <span>强平<br /><b className="font-mono text-down">{p.liq ? px(p.liq) : "—"}</b></span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button type="button" onClick={() => setCoin(p.coin)} className="h-8 flex-1 rounded-lg bg-card text-[12px] font-medium">
                        看行情
                      </button>
                      <button
                        type="button"
                        disabled={!ready}
                        onClick={() => {
                          setClosing(p);
                          setSheet("close");
                        }}
                        className="h-8 flex-1 rounded-lg bg-foreground text-[12px] font-semibold text-background disabled:opacity-40"
                      >
                        市价平仓
                      </button>
                      {canCall && (
                        <button type="button" onClick={() => callFor(p.coin)} className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-card text-[12px] font-medium">
                          <Megaphone size={14} weight="fill" />
                          喊单
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* open orders */}
        {myOrders.length > 0 && (
          <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
            <div className="mb-2 text-[15px] font-semibold">委托</div>
            <ul className="divide-y divide-border/50">
              {myOrders.map((o) => (
                <li key={o.oid} className="flex items-center gap-2 py-2.5 text-[13px]">
                  <span className="font-semibold">{o.coin}</span>
                  <span className={o.side === "long" ? "text-up" : "text-down"}>{o.trigger ? (o.trigger === "tp" ? "止盈" : "止损") : o.side === "long" ? "买" : "卖"}</span>
                  <span className="font-mono text-muted-foreground">
                    {o.trigger ? `触发 ${px(o.triggerPx ?? 0)}` : px(o.px)} · {o.size || "全部"}
                  </span>
                  <button type="button" disabled={!ready} onClick={() => void cancel(o.coin, o.oid)} className="ml-auto h-7 rounded-lg bg-muted px-3 text-[12px] disabled:opacity-40">
                    撤单
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* trade history */}
        {lastTrade && (
          <Link href="/wallet/perp/trades" className="flex items-center gap-2 rounded-[22px] bg-card px-4 py-3.5 ring-1 ring-border/60">
            <span className="shrink-0 text-[15px] font-semibold">成交记录</span>
            <span className="min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground">
              最近 {lastTrade.coin} {DIR[lastTrade.dir] ?? lastTrade.dir} · {new Date(lastTrade.time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <CaretRight size={14} weight="bold" className="shrink-0 text-muted-foreground" />
          </Link>
        )}

        {/* AI history */}
        {log.length > 0 && (
          <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
            <div className="mb-2 text-[15px] font-semibold">AI 历史建议</div>
            <ul className="divide-y divide-border/50">
              {log.slice(0, 10).map((l) => {
                const now = list.data?.find((a) => a.name === l.coin)?.mark;
                const move = now ? (now / l.price - 1) * 100 : null;
                const right = move == null || l.action === "wait" || l.action === "hold" || l.action === "close" ? null : l.action === "long" ? move > 0 : move < 0;
                return (
                  <li key={l.at} className="py-2.5 text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{l.coin}</span>
                      <span>{{ long: "开多", short: "开空", close: "平仓", hold: "持有", wait: "观望" }[l.action] ?? l.action}</span>
                      <span className="text-muted-foreground">@ {px(l.price)} · 信心 {l.confidence}</span>
                      {move != null && (
                        <span className={cn("ml-auto font-mono", right == null ? "text-muted-foreground" : right ? "text-up" : "text-down")}>
                          之后 {move >= 0 ? "+" : ""}
                          {move.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-muted-foreground">{l.summary}</div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <p className="px-2 text-[11px] leading-5 text-muted-foreground">交易在 Hyperliquid 进行，资金在你自己的 Hyperliquid 账户里。合约风险很高，可能亏光保证金；AI 建议不构成投资建议。</p>
      </div>
      <BottomNav />

      <BottomSheet open={sheet === "risk"} onClose={() => {}}>
        {sheet === "risk" && (
          <RiskGate
            onAccept={() => {
              void storeWrite("perp.risk", "1");
              setSheet(null);
            }}
          />
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "deposit"} onClose={() => setSheet(null)}>
        {sheet === "deposit" && (
          <DepositSheet
            main={main()}
            onDone={() => {
              setSheet(null);
              refresh();
            }}
          />
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "withdraw"} onClose={() => setSheet(null)}>
        {sheet === "withdraw" && (
          <WithdrawSheet
            main={main()}
            available={available}
            onDone={() => {
              setSheet(null);
              refresh();
            }}
          />
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "ai"} onClose={() => setSheet(null)}>
        {sheet === "ai" && (
          <AiSettingsSheet
            cfg={aiCfg}
            onSave={saveAi}
            onClear={async () => {
              await vault.saveExtra(AI_CONFIG_KEY, null);
              setVer((v) => v + 1);
              setSheet(null);
              toast.success("已删除 key");
            }}
          />
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "coin"} onClose={() => setSheet(null)}>
        {sheet === "coin" && (
          <CoinPicker
            list={list.data ?? []}
            current={coin}
            onPick={(c) => {
              setCoin(c);
              setAi(null);
              setSheet(null);
            }}
          />
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "confirm"} onClose={() => setSheet(null)}>
        {sheet === "confirm" && asset && (
          <Confirm asset={asset} isLong={isLong} type={type} price={refPx} margin={m} lev={levUsed} notional={notional} size={size} tp={tpN} sl={slN} tpOut={tpOut} slOut={slOut} liq={liqEst} busy={busy === "order"} onCancel={() => setSheet(null)} onOk={() => void place()} />
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "call"} onClose={() => setSheet(null)}>
        {sheet === "call" && callCard && (
          <>
            <div className="flex items-center justify-center gap-1.5 text-[17px] font-semibold">
              <Megaphone size={19} weight="fill" />
              喊单到 {callCard.coin} 合约群
            </div>
            <div className="mt-4 space-y-2 rounded-2xl bg-muted/60 p-4 text-[14px]">
              <Line k="方向" v={`${callCard.side === "long" ? "做多" : "做空"} ${callCard.lev}x`} />
              <Line k={callCard.orderType === "limit" ? "挂单价" : "开仓价"} v={px(callCard.entry)} />
              <Line k="止盈 / 止损" v={`${callCard.tp ? px(callCard.tp) : "—"} / ${callCard.sl ? px(callCard.sl) : "—"}`} />
            </div>
            <textarea value={callNote} onChange={(e) => setCallNote(e.target.value.slice(0, 200))} placeholder="说两句理由（选填）" rows={2} className="mt-3 w-full resize-none rounded-xl bg-muted px-3 py-2 text-[14px] outline-none" />
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">群友会看到你这个仓位的实时状态：持仓中 / 止盈 / 止损 / 平仓 / 强平，以及收益率（不显示金额）。主钱包会签一次名，证明是你自己的仓位。</p>
            <PrimaryButton className="mt-4" disabled={busy === "call"} onClick={() => void sendCall()}>
              {busy === "call" ? "发送中…" : "喊单"}
            </PrimaryButton>
          </>
        )}
      </BottomSheet>
      <BottomSheet open={sheet === "close"} onClose={() => setSheet(null)}>
        {sheet === "close" && closing && (
          <>
            <div className="text-center text-[17px] font-semibold">市价平掉 {closing.coin}？</div>
            <p className="mt-3 text-center text-[14px] text-muted-foreground">
              {closing.side === "long" ? "多" : "空"}单 {closing.size} {closing.coin}，当前浮盈{" "}
              <b className={closing.upnl >= 0 ? "text-up" : "text-down"}>
                {sUsd(closing.upnl)}
              </b>
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <GhostButton onClick={() => setSheet(null)}>取消</GhostButton>
              <PrimaryButton disabled={busy === "close"} onClick={() => void doClose()}>
                {busy === "close" ? "平仓中…" : "确认平仓"}
              </PrimaryButton>
            </div>
          </>
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

function Step({ n, done, title, sub, children }: { n: number; done: boolean; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-3">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold", done ? "bg-up text-white" : "bg-muted")}>{done ? <CheckCircle size={16} weight="bold" /> : n}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="block text-[12px] leading-5 text-muted-foreground">{sub}</span>
      </span>
      {!done && children}
    </div>
  );
}

function SmallBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="h-8 shrink-0 rounded-full bg-foreground px-3.5 text-[12px] font-semibold text-background disabled:opacity-50">
      {children}
    </button>
  );
}

function Outcome({ o }: { o: { pnl: number; roe: number; net: number } }) {
  return (
    <span className={cn("block text-[11px] leading-4", o.net >= 0 ? "text-up" : "text-down")}>
      {o.pnl >= 0 ? "赚" : "亏"} {sUsd(o.pnl)}（{o.roe >= 0 ? "+" : ""}
      {o.roe.toFixed(0)}%）
      <br />
      扣手续费 {sUsd(o.net)}
    </span>
  );
}

function RoeChips({ values, sign, disabled, isOff, onPick }: { values: number[]; sign: "+" | "-"; disabled: boolean; isOff?: (r: number) => boolean; onPick: (r: number) => void }) {
  return (
    <div className="mt-1.5 grid grid-cols-3 gap-1">
      {values.map((r) => (
        <button key={r} type="button" disabled={disabled || isOff?.(r)} onClick={() => onPick(r)} className={cn("h-7 rounded-lg bg-muted text-[11px] font-medium disabled:opacity-35", sign === "+" ? "text-up" : "text-down")}>
          {sign}
          {r}%
        </button>
      ))}
    </div>
  );
}

function Field({ label, value, onChange, unit, placeholder, small, sub }: { label: string; value: string; onChange: (v: string) => void; unit: string; placeholder: string; small?: boolean; sub?: React.ReactNode }) {
  return (
    <label className="mt-3 block rounded-xl bg-muted/70 px-3 py-2">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1">
        <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder={placeholder} className={cn("w-0 flex-1 bg-transparent font-mono font-semibold outline-none", small ? "text-[15px]" : "text-[20px]")} />
        {unit && <span className="text-[12px] text-muted-foreground">{unit}</span>}
      </span>
      {sub}
    </label>
  );
}

const Line = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between">
    <span>{k}</span>
    <span className="font-mono text-foreground">{v}</span>
  </div>
);

type Out = { pnl: number; roe: number; net: number } | null;
function Confirm(p: { asset: HlAsset; isLong: boolean; type: string; price: number; margin: number; lev: number; notional: number; size: number; tp: number; sl: number; tpOut: Out; slOut: Out; liq: number; busy: boolean; onCancel: () => void; onOk: () => void }) {
  return (
    <>
      <div className="text-center text-[17px] font-semibold">
        确认{p.isLong ? "开多" : "开空"} {p.asset.name}
      </div>
      <div className="mt-4 space-y-2 rounded-2xl bg-muted/60 p-4 text-[14px]">
        <Line k="方式" v={p.type === "market" ? "市价" : `限价 ${px(p.price)}`} />
        <Line k="保证金" v={`${usd(p.margin)}（逐仓 ${p.lev}x）`} />
        <Line k="仓位价值" v={usd(p.notional)} />
        <Line k="数量" v={`${p.size.toPrecision(4)} ${p.asset.name}`} />
        <Line k="止盈 / 止损" v={`${p.tp ? px(p.tp) : "—"} / ${p.sl ? px(p.sl) : "—"}`} />
        {p.tpOut && <Line k="到止盈（扣手续费）" v={`${sUsd(p.tpOut.net)}（${p.tpOut.roe >= 0 ? "+" : ""}${p.tpOut.roe.toFixed(0)}%）`} />}
        {p.slOut && <Line k="到止损（扣手续费）" v={`${sUsd(p.slOut.net)}（${p.slOut.roe.toFixed(0)}%）`} />}
        <Line k="预估强平价" v={p.liq ? px(p.liq) : "—"} />
        <Line k="手续费（开 + 平，约）" v={usd(p.notional * TAKER_FEE * 2)} />
      </div>
      <p className="mt-3 text-[12px] leading-5 text-muted-foreground">由这台手机上的交易钥匙签名后提交到 Hyperliquid。{HL_BUILDER ? "平台收 0.05% 手续费（另有 Hyperliquid 自己的手续费）。" : "Hyperliquid 收取交易手续费。"}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton onClick={p.onCancel}>取消</GhostButton>
        <PrimaryButton tone={p.isLong ? "up" : "down"} disabled={p.busy} onClick={p.onOk}>
          {p.busy ? "提交中…" : "确认下单"}
        </PrimaryButton>
      </div>
    </>
  );
}
