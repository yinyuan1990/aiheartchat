"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownUp, Building2, Car, Coins, Crosshair, ExternalLink, Gamepad2, Loader2, Mountain, Ship, Trophy, Wallet } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { toast } from "sonner";
import { useApp } from "@/components/providers";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ADDR, NET, addrUrl, erc20Abi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { V4, boatWithdrawSig, useBoatBoard, useBoatInfo, v4QuoterAbi, vaultAbi, type BoatGame, type BoatInfo } from "@/lib/boat";
import { useBoatAccount } from "@/components/boat/use-boat-account";

const SLIPPAGES = [2, 5, 10];
const num = (n: number | undefined, max = 0) => (n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: max }));
const fmtRaw = (raw: bigint, decimals: number) => {
  const n = Number(formatUnits(raw, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 4 : 8 });
};
const price = (p?: number) => (p === undefined ? "—" : p < 0.001 ? p.toExponential(3) : p.toFixed(6));

export function GamesExplore() {
  const { locale } = useApp();
  const zh = locale === "zh";
  const info = useBoatInfo();
  const d = info.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><Gamepad2 className="size-6 text-primary" />{zh ? "游戏探索" : "Games"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{zh ? "在 Arc 上玩的小游戏。快艇、赛车跑多远，射击、盖楼得多少分，就赚多少 $BOAT；卖在山顶比谁卖得准。" : "Small games on Arc. Earn $BOAT with the speedboat, the race car, the neon shooter or the tower crane, or test your timing in Sell the Top."}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <GameCard href="/boat" icon={<Ship className="size-6" />} title={zh ? "快艇冲冲冲" : "Speedboat Dash"} tag="$BOAT"
          desc={zh ? "连钱包送 100 枚，一局门票 10，跑 1 米得 1 枚，单局最多 300。越往后礁石越密，还有炮击。" : "100 BOAT on sign-in, 10 per run, 1 BOAT per metre up to 300. Rocks get denser, then the artillery starts."} />
        <GameCard href="/race" icon={<Car className="size-6" />} title={zh ? "极速跨海" : "Bridge Rush"} tag="$BOAT"
          desc={zh ? "跨海大桥上从黄昏开到深夜：变道躲车、跳过路障、冲跳台飞过车流，后面还有逆行卡车。规则和快艇一样，同一个 BOAT 余额。" : "Sunset to midnight on a sea bridge: weave through traffic, hop barriers, fly off ramps, dodge wrong-way trucks. Same rules and BOAT balance as the speedboat."} />
        <GameCard href="/shoot" icon={<Crosshair className="size-6" />} title={zh ? "霓虹打击" : "Neon Strike"} tag="$BOAT"
          desc={zh ? "霓虹射击：飞船自动开火，走位躲弹，一枪把 15 种卡通水果切成两半。捡散弹、激光、追踪导弹、全屏炸弹，连击 40 进入狂热，连杀叠倍率最高 ×3。每 10 分得 1 枚，单局最多 300。" : "Neon shooter: auto-fire, dodge, slice 15 kinds of cartoon fruit in half. Grab spread, laser, homing missiles and screen bombs; combo 40 starts a fever, chain kills for up to ×3. 1 BOAT per 10 points up to 300 a run."} />
        <GameCard href="/tower" icon={<Building2 className="size-6" />} title={zh ? "来啊盖楼啊" : "Tower Building"} tag="$BOAT"
          desc={zh ? "一根手指就能玩：吊钩左右摆，点一下放下楼块。叠稳 25 分，正中「完美」加倍，连续完美越加越多；掉 3 块结束。每 10 分得 1 枚，单局最多 300。" : "One-tap stacking: the crane swings, tap to drop the floor. 25 points a floor, more for a dead-centre Perfect and more again in a row; three falls and you're out. 1 BOAT per 10 points, up to 300 a run."} />
        <GameCard href="/game" icon={<Mountain className="size-6" />} title={zh ? "卖在山顶" : "Sell the Top"} tag={zh ? "免费" : "Free"}
          desc={zh ? "每天一个真实 Arc 新币开盘，你是第一个散户，只能按一次卖出。只比成绩，没有奖品。" : "One real Arc launch a day, you're the first retail buyer, one sell. Bragging rights only."} />
      </div>

      {!d?.enabled ? (
        <Card><CardContent className="p-5 text-sm text-muted-foreground">
          {info.isLoading ? <Loader2 className="size-4 animate-spin" /> : zh ? "$BOAT 还没上线，快艇现在可以免费试玩，不计奖励。" : "$BOAT is not live yet. The speedboat is free to play, without rewards."}
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            <BoatStats d={d} zh={zh} />
            <MyBoat d={d} zh={zh} />
            <Board zh={zh} />
          </div>
          <Trade d={d} zh={zh} />
        </div>
      )}
    </div>
  );
}

function GameCard({ href, icon, title, tag, desc }: { href: string; icon: React.ReactNode; title: string; tag: string; desc: string }) {
  return (
    <Link href={href} className="group">
      <Card className="h-full transition-colors group-hover:border-primary/60">
        <CardContent className="flex gap-4 p-5">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{icon}</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">{title}<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{tag}</span></div>
            <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function BoatStats({ d, zh }: { d: BoatInfo; zh: boolean }) {
  const cap = d.rules.globalDailyCap;
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold"><Coins className="size-5 text-amber-500" />$BOAT</div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            {d.boat && <a href={addrUrl(d.boat)} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">{zh ? "代币" : "Token"} {shortAddr(d.boat)}<ExternalLink className="size-3" /></a>}
            {d.vault && <a href={addrUrl(d.vault)} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">{zh ? "金库" : "Vault"} {shortAddr(d.vault)}<ExternalLink className="size-3" /></a>}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label={zh ? "价格 (USDC)" : "Price (USDC)"} value={price(d.priceUsdc)} />
          <Stat label={zh ? "市值" : "Market cap"} value={`$${num(d.mcapUsdc)}`} />
          <Stat label={zh ? "奖池" : "Reward pool"} value={num(d.rewardPool)} />
          <Stat label={zh ? "每米奖励" : "Per metre"} value={d.rate >= 1 ? "1" : d.rate.toFixed(2)} />
        </dl>
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{zh ? "今日已发" : "Paid today"}</span><span className="font-mono">{num(d.paidToday)} / {num(cap)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-amber-500" style={{ width: `${Math.min(100, ((d.paidToday ?? 0) / cap) * 100)}%` }} /></div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {zh
            ? "10 亿枚发行时全部进金库合约：6 亿锁进 Uniswap V4 池子（没有撤池函数），4 亿是游戏奖池。池子 1% 手续费归金库，USDC 部分回购 BOAT 进奖池。奖池少于 1 亿枚时每米奖励按比例下降，最低 0.1。每人每天最多提 1,500，全站每天最多 100 万。"
            : "All 1B tokens go to the vault contract at launch: 600M locked in a Uniswap V4 pool (no withdraw function), 400M as the reward pool. The pool's 1% fee goes to the vault; USDC fees buy BOAT back into the pool. Below 100M in the pool, the per-metre reward scales down (min 0.1). Withdrawals: 1,500 per player and 1M in total per day."}
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono font-semibold">{value}</dd>
    </div>
  );
}

function MyBoat({ d, zh }: { d: BoatInfo; zh: boolean }) {
  const acct = useBoatAccount();
  const { run, client } = useTx();
  const [busy, setBusy] = useState<"withdraw" | "deposit" | null>(null);
  const me = acct.me;
  const wallet = acct.address as Address | undefined;
  const bal = useReadContract({ address: d.boat, abi: erc20Abi, functionName: "balanceOf", args: wallet ? [wallet] : undefined, query: { enabled: !!wallet && !!d.boat, refetchInterval: 10_000 } });

  const withdraw = async () => {
    if (!acct.token || !d.vault) return;
    setBusy("withdraw");
    try {
      const c = await boatWithdrawSig(acct.token);
      await run(zh ? `提现 ${c.amount} BOAT` : `Withdraw ${c.amount} BOAT`, { address: c.vault, abi: vaultAbi, functionName: "claim", args: [BigInt(c.total), BigInt(c.deadline), c.sig] });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      toast.error(m === "daily cap" ? (zh ? "今天的提现额度用完了，明天再来" : "Today's withdrawal limit is used up") : m === "nothing" ? (zh ? "没有可提现的余额" : "Nothing to withdraw") : m);
    } finally {
      setBusy(null);
      void acct.refresh(); void bal.refetch();
    }
  };
  const deposit = async () => {
    const amt = bal.data ?? 0n;
    if (!wallet || !d.vault || !d.boat || amt === 0n || !client) return;
    setBusy("deposit");
    try {
      const allowance = await client.readContract({ address: d.boat, abi: erc20Abi, functionName: "allowance", args: [wallet, d.vault] });
      if (allowance < amt && !(await run(zh ? "授权 BOAT" : "Approve BOAT", { address: d.boat, abi: erc20Abi, functionName: "approve", args: [d.vault, maxUint256] }))) return;
      await run(zh ? "转入游戏" : "Deposit to game", { address: d.vault, abi: vaultAbi, functionName: "deposit", args: [amt] });
      toast(zh ? "到账约需 15 秒" : "Credited in ~15 s");
    } finally {
      setBusy(null);
      void acct.refresh(); void bal.refetch();
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="font-semibold">{zh ? "我的 BOAT" : "My BOAT"}</div>
        {!me ? (
          <Button onClick={() => void acct.login()} disabled={acct.busy} className="w-full">
            {acct.busy ? <Loader2 className="animate-spin" /> : <Wallet />}
            {!acct.connected ? (zh ? "连接钱包" : "Connect wallet") : (zh ? "签名登录（免费，送 100 BOAT）" : "Sign in (free, 100 BOAT)")}
          </Button>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <Stat label={zh ? "可提现" : "Withdrawable"} value={num(me.cash)} />
              <Stat label={zh ? "体验币（只能玩）" : "Bonus (play only)"} value={num(me.bonus)} />
              <Stat label={zh ? "钱包里" : "In wallet"} value={bal.data !== undefined ? fmtRaw(bal.data, 18) : "—"} />
            </dl>
            {me.pending && <p className="text-xs text-amber-600">{zh ? `有一笔 ${me.pending.amount} 的提现待确认，再点「提现」可以重新发起。` : `A ${me.pending.amount} BOAT withdrawal is pending; press Withdraw to retry it.`}</p>}
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => void withdraw()} disabled={!!busy || (me.cash <= 0 && !me.pending)}>{busy === "withdraw" && <Loader2 className="animate-spin" />}{zh ? "提现到钱包" : "Withdraw"}</Button>
              <Button variant="outline" onClick={() => void deposit()} disabled={!!busy || !bal.data}>{busy === "deposit" && <Loader2 className="animate-spin" />}{zh ? "钱包 BOAT 转入游戏" : "Deposit wallet BOAT"}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{zh ? `今日计分 ${me.runsToday}/${me.runsPerDay} 局 · 最佳 ${me.best} 米 · 累计赢 ${num(me.earned)}。送的 100 枚只能玩，开局优先扣它。` : `Ranked today ${me.runsToday}/${me.runsPerDay} · best ${me.best} m · earned ${num(me.earned)}. The 100 bonus is spent on entries first and can't be withdrawn.`}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Board({ zh }: { zh: boolean }) {
  const [game, setGame] = useState<BoatGame>("boat");
  const b = useBoatBoard(game);
  const rows = b.data?.rows ?? [];
  const points = game === "shoot" || game === "tower";
  const label = { boat: zh ? "快艇" : "Boat", race: zh ? "赛车" : "Race", shoot: zh ? "射击" : "Shoot", tower: zh ? "盖楼" : "Tower" };
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold"><Trophy className="size-4 text-amber-500" />{points ? (zh ? "今日最高分" : "Today's top scores") : (zh ? "今日最远" : "Today's longest")}</div>
          <div className="flex rounded-lg bg-muted p-0.5 text-xs">
            {(["boat", "race", "shoot", "tower"] as const).map((g) => (
              <button key={g} type="button" onClick={() => setGame(g)}
                className={cn("rounded-md px-2.5 py-1 font-medium", game === g ? "bg-background shadow-sm" : "text-muted-foreground")}>
                {label[g]}
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{zh ? "今天还没人跑，去拿第一。" : "No runs yet today."}</p> : (
          <ol className="space-y-1 text-sm">
            {rows.map((r, i) => (
              <li key={r.wallet} className="flex justify-between font-mono"><span>{i + 1}. {shortAddr(r.wallet)}</span><span>{points ? `${r.meters.toLocaleString()} ${zh ? "分" : "pts"}` : `${r.meters} m`}</span></li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function Trade({ d, zh }: { d: BoatInfo; zh: boolean }) {
  const { t, connected, address, wrongChain, toggleConnect } = useApp();
  const { run, client } = useTx();
  const me = address as Address | undefined;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("5");
  const [slip, setSlip] = useState(2);
  const [busy, setBusy] = useState(false);
  const vault = d.vault!;
  const boat = d.boat!;
  const tokenIn = side === "buy" ? ADDR.usdc : boat;
  const decIn = side === "buy" ? 6 : 18;
  const decOut = side === "buy" ? 18 : 6;
  let amt = 0n;
  try { amt = amount ? parseUnits(amount, decIn) : 0n; } catch { amt = 0n; }

  const usdcBal = useReadContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 8000 } });
  const boatBal = useReadContract({ address: boat, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 8000 } });
  const balIn = side === "buy" ? usdcBal.data : boatBal.data;

  const quote = useQuery({
    queryKey: ["boat", "quote", side, amt.toString()],
    enabled: amt > 0n && !!client,
    refetchInterval: 8000,
    retry: false,
    queryFn: async () => {
      const key = await client!.readContract({ address: vault, abi: vaultAbi, functionName: "poolKey" });
      const zeroForOne = side === "buy" ? !d.boatIsToken0 : !!d.boatIsToken0;
      const { result } = await client!.simulateContract({ address: V4.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne, exactAmount: amt, hookData: "0x" }] });
      return result[0];
    },
  });

  const go = async () => {
    if (!me || !client || !quote.data || busy) return;
    setBusy(true);
    try {
      const allowance = await client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [me, vault] });
      if (allowance < amt && !(await run(t("tx.approving"), { address: tokenIn, abi: erc20Abi, functionName: "approve", args: [vault, maxUint256] }))) return;
      const minOut = quote.data - (quote.data * BigInt(slip * 100)) / 10_000n;
      await run(side === "buy" ? "USDC → BOAT" : "BOAT → USDC", { address: vault, abi: vaultAbi, functionName: side, args: [amt, minOut, me] });
      setAmount("");
    } finally {
      setBusy(false);
      void usdcBal.refetch(); void boatBal.refetch();
    }
  };

  const insufficient = balIn !== undefined && amt > balIn;
  const cta = !connected ? t("common.connect") : wrongChain ? t(`wallet.switch.${NET}`) : insufficient ? t("tools.insufficient")
    : side === "buy" ? (zh ? "买入 BOAT" : "Buy BOAT") : (zh ? "卖出 BOAT" : "Sell BOAT");
  const presets = side === "buy" ? ["1", "5", "20", "50"] : null;

  return (
    <Card className="h-fit">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold"><ArrowDownUp className="size-4" />{zh ? "交易 BOAT" : "Trade BOAT"}</div>
          <span className="text-xs text-muted-foreground">Uniswap V4 · 1%</span>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} type="button" onClick={() => { setSide(s); setAmount(""); }}
              className={cn("rounded-md py-1.5 text-sm font-semibold", side === s ? (s === "buy" ? "bg-up text-white" : "bg-down text-white") : "text-muted-foreground")}>
              {s === "buy" ? (zh ? "买入" : "Buy") : (zh ? "卖出" : "Sell")}
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t("tools.pay")}</span>
            {balIn !== undefined && (
              <button type="button" className="font-mono hover:text-foreground" onClick={() => setAmount(formatUnits(balIn, decIn))}>
                {t("tools.balance")} {fmtRaw(balIn, decIn)} {side === "buy" ? "USDC" : "BOAT"}
              </button>
            )}
          </div>
          <div className="relative">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" className="pr-16 font-mono" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{side === "buy" ? "USDC" : "BOAT"}</span>
          </div>
          {presets && (
            <div className="grid grid-cols-4 gap-1.5">
              {presets.map((p) => <Button key={p} size="sm" variant={amount === p ? "default" : "outline"} className="font-mono" onClick={() => setAmount(p)}>{p}u</Button>)}
            </div>
          )}
          {side === "sell" && boatBal.data !== undefined && boatBal.data > 0n && (
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setAmount(formatUnits(boatBal.data! / 2n, 18))}>{zh ? "一半" : "Half"}</Button>
              <Button size="sm" variant="outline" onClick={() => setAmount(formatUnits(boatBal.data!, 18))}>{zh ? "全部" : "All"}</Button>
            </div>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <dt>{t("tools.receive")}</dt>
          <dd className="text-right font-mono text-foreground">
            {quote.isFetching && quote.data === undefined ? t("tools.quoting") : quote.data !== undefined ? `${fmtRaw(quote.data, decOut)} ${side === "buy" ? "BOAT" : "USDC"}` : "—"}
          </dd>
          <dt>{t("common.slippage")}</dt>
          <dd className="flex justify-end gap-1">
            {SLIPPAGES.map((s) => (
              <button key={s} type="button" onClick={() => setSlip(s)} className={cn("rounded px-1.5 font-mono", slip === s ? "bg-primary text-primary-foreground" : "hover:text-foreground")}>{s}%</button>
            ))}
          </dd>
        </dl>
        <Button size="lg" className="w-full" variant={side === "buy" ? "default" : "destructive"}
          disabled={connected && !wrongChain && (busy || insufficient || !quote.data)}
          onClick={!connected || wrongChain ? toggleConnect : () => void go()}>
          {busy ? <Loader2 className="animate-spin" /> : !connected ? <Wallet /> : null}{cta}
        </Button>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {zh ? "直接和金库合约成交，金库再和 Uniswap V4 池子换。买卖都收 1% 池费，这部分归金库、补进游戏奖池。meme 币价格波动大，只用闲钱。" : "Trades go through the vault contract into the Uniswap V4 pool. The 1% pool fee goes to the vault and back into the reward pool. Meme coins are volatile: only use spare money."}
        </p>
      </CardContent>
    </Card>
  );
}
