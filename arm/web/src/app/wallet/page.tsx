"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { ArrowDown, ArrowUp, ArrowsLeftRight, CaretDown, CheckCircle, Copy, Eye, EyeSlash, GasPump, GearSix, Lock, Plus, ArrowSquareOut, Wallet as WalletIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { useWallet } from "@/lib/api";
import { fmtSmall, shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WALLET_CHAINS, explorerAddr, explorerTx, isSolana, probeChainNode, probeNode, publicClientFor, rpcOf, useNodes, type WalletChain } from "@/lib/wallet/chains";
import { absUrl, useAssets, type Asset } from "@/lib/wallet/assets";
import { copyText } from "@/lib/wallet/native";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomNav, BottomSheet, ChainGlyph, ChainPill, IconButton, Num, Pct, WalletFrame } from "@/components/wallet/ui";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 }));
const price = (p: number) => (p >= 1 ? usd(p) : `$${fmtSmall(p)}`);

export default function WalletHome() {
  const { active, chain, setChain, wallets, switchTo, lock, address } = useVault();
  const { assets, total, change, loading: loadingAssets } = useAssets(chain, address);
  const noSol = isSolana(chain) && !address;
  const loading = loadingAssets && !noSol;
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<"tokens" | "activity">("tokens");
  const [sheet, setSheet] = useState<null | "chain" | "wallet">(null);
  const [int, dec] = usd(total).split(".");
  const pct = total > change ? (change / (total - change)) * 100 : 0;

  const copy = async () => {
    if (address && (await copyText(address))) toast.success("地址已复制");
  };

  return (
    <WalletFrame>
      <header className="flex h-14 items-center gap-2 px-4">
        <button type="button" onClick={() => setSheet("wallet")} className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 pl-1 transition active:scale-95 hover:bg-muted">
          {address && <WalletDot address={address} size={28} />}
          <span className="truncate text-[15px] font-semibold">{active?.name}</span>
          <CaretDown size={12} weight="bold" className="shrink-0 text-muted-foreground" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          <ChainPill chain={chain} onClick={() => setSheet("chain")} />
          <IconButton label="锁定" onClick={lock}>
            <Lock size={21} />
          </IconButton>
          <Link href="/wallet/me" aria-label="设置" className="flex size-10 items-center justify-center rounded-full text-foreground/80 transition active:scale-90 hover:bg-muted">
            <GearSix size={22} />
          </Link>
        </div>
      </header>

      <section className="px-4 pt-2">
        <div className="relative overflow-hidden rounded-[28px] bg-[#0d0d0f] p-5 text-white shadow-[0_18px_40px_-18px_rgba(0,0,0,0.6)] dark:bg-[#17171c] dark:ring-1 dark:ring-white/10">
          <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.22),transparent_65%)]" />
          <div className="pointer-events-none absolute -bottom-28 -left-10 size-64 rounded-full bg-[radial-gradient(circle,rgba(120,160,255,0.18),transparent_65%)]" />
          <div className="relative flex items-center gap-2 text-[13px] text-white/60">
            {chain.name} 资产
            <button type="button" aria-label={hidden ? "显示金额" : "隐藏金额"} onClick={() => setHidden((v) => !v)} className="transition active:scale-90">
              {hidden ? <EyeSlash size={16} /> : <Eye size={16} />}
            </button>
            <NetStatus chain={chain} />
          </div>
          <div className="relative mt-1 flex h-11 items-baseline font-mono tracking-tight">
            {loading ? (
              <span className="mt-1 h-9 w-40 animate-pulse rounded-lg bg-white/10" />
            ) : hidden ? (
              <span className="text-[40px] font-semibold">••••••</span>
            ) : (
              <>
                <span className="text-[40px] leading-none font-semibold">{int}</span>
                <span className="text-[22px] font-medium text-white/50">.{dec}</span>
              </>
            )}
          </div>
          <div className="relative mt-2 flex h-6 items-center gap-2 text-[13px]">
            {!loading && total > 0 && (
              <>
                <span className={cn("rounded-full px-2 py-0.5 font-mono", change >= 0 ? "bg-[#26a69a]/20 text-[#4fd1c5]" : "bg-[#ef5350]/20 text-[#ff8a80]")}>
                  {change >= 0 ? "+" : "−"}
                  {usd(Math.abs(change))} · {pct >= 0 ? "+" : "−"}
                  {Math.abs(pct).toFixed(2)}%
                </span>
                <span className="text-white/45">24 小时</span>
              </>
            )}
          </div>
          <button type="button" onClick={copy} className="relative mt-3 flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 font-mono text-[12px] text-white/80 transition active:scale-95">
            {address && shortAddr(address, 6, 4)}
            <Copy size={13} />
          </button>
        </div>
      </section>

      <section className="grid grid-cols-4 gap-2 px-4 pt-4">
        {[
          { href: "/wallet/receive", label: "收款", icon: ArrowDown },
          { href: "/wallet/send", label: "转账", icon: ArrowUp },
          { href: "/wallet/token", label: "交易", icon: ArrowsLeftRight },
          { href: "/wallet/receive?deposit=1", label: "充值", icon: Plus },
        ].map((a) => (
          <Link key={a.label} href={a.href} className="flex flex-col items-center gap-1.5 rounded-2xl py-2 transition active:scale-95">
            <span className="flex size-[52px] items-center justify-center rounded-[18px] bg-card shadow-[0_1px_0_rgba(0,0,0,0.04),0_6px_16px_-8px_rgba(0,0,0,0.18)] ring-1 ring-border/70">
              <a.icon size={22} weight="bold" />
            </span>
            <span className="text-[12px] text-foreground/80">{a.label}</span>
          </Link>
        ))}
      </section>

      <section className="mt-4 flex-1 rounded-t-[28px] bg-card px-4 pt-4">
        <div className="flex items-center gap-5">
          {(["tokens", "activity"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn("relative pb-2 text-[16px] font-semibold transition", tab === k ? "text-foreground" : "text-muted-foreground")}>
              {k === "tokens" ? "代币" : "动态"}
              <span className={cn("absolute inset-x-1 bottom-0 h-[3px] rounded-full bg-foreground transition-opacity", tab === k ? "opacity-100" : "opacity-0")} />
            </button>
          ))}
        </div>

        {noSol ? (
          <div className="py-8 text-center text-[13px] leading-6 text-muted-foreground">
            「{active?.name}」是用私钥导入的，只有 EVM 地址，没有 Solana 账户。
            <br />
            用助记词新建或导入的钱包会自动带上 Solana 地址。
          </div>
        ) : tab === "tokens" ? (
          loading ? (
            <ul className="mt-2 space-y-3">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 py-2">
                  <span className="size-[42px] animate-pulse rounded-full bg-muted" />
                  <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="mt-1 divide-y divide-border/50">
              {assets.map((a) => (
                <AssetRow key={a.id} a={a} chain={chain} hidden={hidden} />
              ))}
              {assets.every((a) => a.raw === 0n) && (
                <li className="py-8 text-center text-[13px] leading-6 text-muted-foreground">
                  这个钱包在 {chain.name} 上还没有资产
                  <br />
                  <Link href="/wallet/receive" className="font-medium text-foreground underline underline-offset-4">
                    去收款 / 充值
                  </Link>
                </li>
              )}
            </ul>
          )
        ) : (
          <ActivityList chainKey={chain.key} address={address} />
        )}
        <div className="h-4" />
      </section>

      <div className="bg-card">
        <BottomNav />
      </div>

      <BottomSheet open={sheet === "chain"} onClose={() => setSheet(null)}>
        <div className="mb-3 text-center text-[17px] font-semibold">选择网络</div>
        <ul className="space-y-1">
          {WALLET_CHAINS.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => {
                  setChain(c.key);
                  setSheet(null);
                }}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-3 transition active:scale-[0.99]", c.key === chain.key ? "bg-muted" : "hover:bg-muted/60")}
              >
                <ChainGlyph chain={c} size={32} />
                <span className="flex-1 text-left">
                  <span className="block text-[15px] font-semibold">{c.name}</span>
                  <span className="block text-[12px] text-muted-foreground">网络费用 {c.chain.nativeCurrency.symbol} 支付</span>
                </span>
                {c.key === chain.key && <CheckCircle size={22} weight="fill" />}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      <BottomSheet open={sheet === "wallet"} onClose={() => setSheet(null)}>
        <div className="mb-3 text-center text-[17px] font-semibold">我的钱包</div>
        <ul className="space-y-1">
          {wallets.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={async () => {
                  await switchTo(w.id);
                  setSheet(null);
                }}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-3 transition active:scale-[0.99]", w.id === active?.id ? "bg-muted" : "hover:bg-muted/60")}
              >
                <WalletDot address={w.address} size={36} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[15px] font-semibold">{w.name}</span>
                  <span className="block font-mono text-[12px] text-muted-foreground">
                    {isSolana(chain) ? (w.sol ? shortAddr(w.sol, 6, 4) : "无 Solana 账户") : shortAddr(w.address, 6, 4)} · {w.kind === "mnemonic" ? "助记词" : "私钥"}
                  </span>
                </span>
                {w.id === active?.id && <CheckCircle size={22} weight="fill" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Link href="/wallet/create" className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[14px] font-semibold">
            <Plus size={16} weight="bold" />
            新建
          </Link>
          <Link href="/wallet/import" className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[14px] font-semibold">
            <WalletIcon size={16} weight="bold" />
            导入
          </Link>
        </div>
      </BottomSheet>
    </WalletFrame>
  );
}

const gwei = (wei: bigint) => {
  const g = Number(formatUnits(wei, 9));
  return g >= 100 ? g.toFixed(0) : g >= 1 ? g.toFixed(1) : g >= 0.01 ? g.toFixed(2) : "<0.01";
};

/** Current node round trip + gas price, like the strip on Ave's home; tap → nodes page. */
function NetStatus({ chain }: { chain: WalletChain }) {
  useNodes();
  const q = useQuery({
    queryKey: ["wallet", "net-status", chain.key, rpcOf(chain)],
    // gas price first: it opens the connection, so the probe measures a round trip rather than DNS + TLS setup
    queryFn: async () => {
      if (isSolana(chain)) {
        await probeChainNode(chain, rpcOf(chain));
        const probe = await probeChainNode(chain, rpcOf(chain));
        return { ms: probe.error ? null : probe.ms, gas: null };
      }
      const gas = await publicClientFor(chain).getGasPrice().catch(() => null);
      const probe = await probeNode(rpcOf(chain));
      return { ms: probe.error ? null : probe.ms, gas };
    },
    refetchInterval: 15_000,
  });
  const ms = q.data?.ms;
  const dot = ms == null ? (q.data ? "bg-[#ff8a80]" : "bg-white/30") : ms < 300 ? "bg-[#4fd1c5]" : ms < 1000 ? "bg-[#f5c26b]" : "bg-[#ff8a80]";
  return (
    <Link href="/wallet/nodes" aria-label="节点和网络费" className="ml-auto flex items-center gap-2 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px] text-white/70 transition active:scale-95">
      <span className="flex items-center gap-1">
        <span className={cn("size-1.5 rounded-full", dot)} />
        {q.data ? (ms != null ? `${ms}ms` : "连不上") : "…"}
      </span>
      {q.data?.gas != null && (
        <span className="flex items-center gap-0.5">
          <GasPump size={12} />
          {gwei(q.data.gas)} Gwei
        </span>
      )}
    </Link>
  );
}

function AssetRow({ a, chain, hidden }: { a: Asset; chain: (typeof WALLET_CHAINS)[number]; hidden: boolean }) {
  const href = a.arm ? `/wallet/token?address=${a.token}` : a.boat ? "/wallet/boat" : a.pump && a.mint ? `/wallet/coin?mint=${a.mint}` : `/wallet/send?asset=${a.id}`;
  return (
    <li>
      <Link href={href} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
        <div className="relative">
          <TokenAvatar symbol={a.symbol} seed={a.seed} logo={a.logo} size={42} className="rounded-full" />
          <span className="absolute -right-0.5 -bottom-0.5">
            <ChainGlyph chain={chain} size={16} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold">{a.symbol}</span>
            {a.gas && <span className="rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">网络费</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
            {a.priceUsd != null ? <Num value={price(a.priceUsd)} /> : <span>—</span>}
            {a.change24h != null && a.change24h !== 0 && <Pct value={a.change24h} className="text-[12px]" />}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[15px] font-medium tabular-nums">{hidden ? "••••" : amt(a.amount)}</div>
          <div className="mt-0.5 font-mono text-[12px] text-muted-foreground tabular-nums">{hidden ? "••••" : a.valueUsd != null ? usd(a.valueUsd) : "—"}</div>
        </div>
      </Link>
    </li>
  );
}

function ActivityList({ chainKey, address }: { chainKey: string; address?: string }) {
  const chain = WALLET_CHAINS.find((c) => c.key === chainKey)!;
  const w = useWallet(chainKey === "arc" ? address : undefined);
  if (chainKey !== "arc") {
    return (
      <div className="py-8 text-center text-[13px] text-muted-foreground">
        {chain.name} 的交易记录请到区块浏览器查看
        <br />
        {address && (
          <a href={explorerAddr(chain, address)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
            打开 {chain.explorer.replace("https://", "")}
            <ArrowSquareOut size={14} />
          </a>
        )}
      </div>
    );
  }
  const trades = w.data?.trades ?? [];
  if (w.isLoading) return <div className="py-8 text-center text-[13px] text-muted-foreground">加载中…</div>;
  if (trades.length === 0) return <div className="py-8 text-center text-[13px] text-muted-foreground">还没有 Arm 交易记录</div>;
  return (
    <ul className="mt-1 divide-y divide-border/50">
      {trades.slice(0, 50).map((t) => (
        <li key={t.hash + t.token}>
          <a href={explorerTx(chain, t.hash)} target="_blank" rel="noreferrer" className="flex items-center gap-3 py-3">
            <TokenAvatar symbol={t.symbol} seed={t.token} logo={absUrl(t.logo)} size={42} className="rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">
                {t.side === "buy" ? "买入" : "卖出"} {t.symbol}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">Arm · {timeAgo(new Date(t.time).getTime())}</div>
            </div>
            <div className="text-right font-mono">
              <div className={cn("text-[14px]", t.side === "buy" ? "text-up" : "")}>
                {t.side === "buy" ? "+" : "−"}
                {amt(Number(t.tokens) / 1e18)}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {t.side === "buy" ? "−" : "+"}
                {(Number(t.usdc) / 1e6).toFixed(2)} USDC
              </div>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
