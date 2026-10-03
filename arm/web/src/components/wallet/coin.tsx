"use client";

import { useState } from "react";
import { ArrowBendUpLeft, CircleNotch, Copy, Crown, Globe, PaperPlaneRight, TelegramLogo, XLogo } from "@phosphor-icons/react";
import { toast } from "sonner";
import { PriceChart, type Candle } from "@/components/token/price-chart";
import { TokenAvatar } from "@/components/shared";
import { fmtNum, fmtSmall, shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/wallet/native";
import { Num, Pct, PrimaryButton } from "./ui";

/**
 * The pump.fun-style coin page, shared by Solana (pump) coins and Arm coins: market cap hero with ATH bar, chart,
 * bonding-curve card, position, then 讨论 / 成交 / 持有人 tabs and the about card, with buy / sell pinned at the
 * bottom. Each page maps its own data into these props.
 */

export const usd = (n: number) => (n >= 1 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${fmtSmall(n)}`);
export const compactUsd = (n: number) => `$${fmtNum(n, n >= 1000 ? 1 : 2)}`;

export function CoinTitle({ symbol, name, image, seed, address }: { symbol: string; name: string; image?: string; seed: string; address: string }) {
  return (
    <div className="flex items-center gap-2">
      <TokenAvatar symbol={symbol} seed={seed} logo={image} size={32} className="rounded-full" />
      <div className="min-w-0 leading-tight">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[15px] font-semibold">{name}</span>
          <span className="shrink-0 text-[12px] font-normal text-muted-foreground">{symbol}</span>
        </div>
        <button type="button" onClick={async () => (await copyText(address)) && toast.success("合约地址已复制")} className="flex items-center gap-1 font-mono text-[11px] font-normal text-muted-foreground">
          {shortAddr(address, 6, 4)}
          <Copy size={11} />
        </button>
      </div>
    </div>
  );
}

export type CoinChange = { label: string; value: number | null };

export function CoinHero({ mcapUsd, priceUsd, athMcapUsd, changes, badge }: { mcapUsd: number; priceUsd: number; athMcapUsd?: number | null; changes: CoinChange[]; badge?: React.ReactNode }) {
  const ath = athMcapUsd && athMcapUsd > 0 ? Math.max(athMcapUsd, mcapUsd) : null;
  const main = changes.find((c) => c.value != null);
  return (
    <section className="px-4 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-muted-foreground">市值</div>
          <Num value={compactUsd(mcapUsd)} className="text-[32px] leading-tight font-semibold tracking-tight" />
          <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
            {main && <Pct value={main.value!} className="text-[13px]" />}
            {main && <span>{main.label}</span>}
            <span>· 价格</span>
            <Num value={usd(priceUsd)} className="text-[12px] text-foreground" />
          </div>
        </div>
        {badge}
      </div>
      {ath && (
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>距历史最高</span>
            <span className="font-mono">ATH {compactUsd(ath)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-up" style={{ width: `${Math.max(2, Math.min(100, (mcapUsd / ath) * 100))}%` }} />
          </div>
        </div>
      )}
      <div className="mt-3 grid grid-cols-4 gap-2">
        {changes.map((c) => (
          <div key={c.label} className="rounded-xl bg-card py-1.5 text-center ring-1 ring-border/60">
            <div className="text-[11px] text-muted-foreground">{c.label}</div>
            {c.value == null ? <div className="font-mono text-[13px] text-muted-foreground">—</div> : <Pct value={c.value} className="text-[13px] font-semibold" />}
          </div>
        ))}
      </div>
    </section>
  );
}

export function CoinChart({ intervals, interval, onInterval, candles, loading }: { intervals: { key: string; label: string }[]; interval: string; onInterval: (k: string) => void; candles: Candle[]; loading: boolean }) {
  return (
    <section className="mt-4">
      <div className="flex gap-1 px-4">
        {intervals.map((r) => (
          <button key={r.key} type="button" onClick={() => onInterval(r.key)} className={cn("h-8 rounded-full px-3 text-[13px] font-medium transition", r.key === interval ? "bg-foreground text-background" : "text-muted-foreground")}>
            {r.label}
          </button>
        ))}
      </div>
      {candles.length > 1 ? <PriceChart candles={candles} className="mt-2 h-[240px]" /> : <div className="mt-2 flex h-[240px] items-center justify-center text-[13px] text-muted-foreground">{loading ? "加载中…" : "暂无成交"}</div>}
    </section>
  );
}

/** pump's "bonding curve progress" card; once graduated it says where the coin trades now. */
export function CurveCard({ progress, complete, venue, lines }: { progress: number; complete: boolean; venue: string; lines: string[] }) {
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">{complete ? "已毕业" : "联合曲线进度"}</span>
        <span className={cn("font-mono text-[14px] font-semibold", complete ? "text-up" : "")}>{complete ? venue : `${progress.toFixed(1)}%`}</span>
      </div>
      <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-up/70 to-up transition-[width] duration-500" style={{ width: `${complete ? 100 : Math.max(1.5, progress)}%` }} />
      </div>
      {lines.map((l) => (
        <p key={l} className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {l}
        </p>
      ))}
    </section>
  );
}

export function PositionCard({ amount, value, pnl }: { amount: string; value: string; pnl?: number | null }) {
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="text-[14px] font-semibold">我的持仓</div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="数量" value={amount} />
        <Stat label="价值" value={value} />
        <Stat label="盈亏" value={pnl == null ? "—" : `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`} className={pnl == null ? "" : pnl >= 0 ? "text-up" : "text-down"} />
      </div>
    </section>
  );
}

export function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[14px] font-semibold", className)}>{value}</div>
    </div>
  );
}

export type CoinTab = { key: string; label: string; count?: number; render: () => React.ReactNode };

export function CoinTabs({ tabs }: { tabs: CoinTab[] }) {
  const [on, setOn] = useState(tabs[0]?.key);
  const cur = tabs.find((t) => t.key === on) ?? tabs[0];
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="flex gap-4 border-b border-border/60">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setOn(t.key)} className={cn("-mb-px border-b-2 pb-2 text-[14px] font-semibold transition", t.key === cur?.key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground")}>
            {t.label}
            {t.count != null && <span className="ml-1 text-[12px] font-normal text-muted-foreground">{fmtNum(t.count)}</span>}
          </button>
        ))}
      </div>
      <div className="pt-1">{cur?.render()}</div>
    </section>
  );
}

export type CoinTradeItem = { id: string; side: "buy" | "sell"; who: string; amount: string; value: string; at: number; href?: string };

export function TradeRows({ items, loading }: { items: CoinTradeItem[]; loading?: boolean }) {
  if (loading && items.length === 0) return <Spinner />;
  if (items.length === 0) return <Empty text="还没有成交" />;
  return (
    <ul className="divide-y divide-border/50">
      {items.map((t) => {
        const row = (
          <>
            <span className={cn("w-9 shrink-0 rounded-md py-0.5 text-center text-[11px] font-semibold", t.side === "buy" ? "bg-up/12 text-up" : "bg-down/12 text-down")}>{t.side === "buy" ? "买" : "卖"}</span>
            <span className="w-24 shrink-0 truncate font-mono text-muted-foreground">{shortAddr(t.who, 4, 4)}</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-muted-foreground">{t.amount}</span>
            <span className="w-16 shrink-0 text-right font-mono font-medium">{t.value}</span>
            <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground">{timeAgo(t.at)}</span>
          </>
        );
        return (
          <li key={t.id}>
            {t.href ? (
              <a href={t.href} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2.5 text-[13px]">
                {row}
              </a>
            ) : (
              <div className="flex items-center gap-2 py-2.5 text-[13px]">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export type CoinHolderItem = { address: string; pct: number; tags: string[]; href?: string; me?: boolean };

export function HolderRows({ items, loading, summary }: { items: CoinHolderItem[]; loading?: boolean; summary?: string[] }) {
  if (loading && items.length === 0) return <Spinner />;
  return (
    <>
      {summary && summary.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2.5">
          {summary.map((s) => (
            <span key={s} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {s}
            </span>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <Empty text="暂无持有人数据" />
      ) : (
        <ol className="mt-1">
          {items.map((h, i) => (
            <li key={h.address}>
              <a href={h.href} target="_blank" rel="noreferrer" className="relative flex items-center gap-2 overflow-hidden rounded-lg px-1 py-2 text-[13px]">
                <span className="absolute inset-y-1 left-0 rounded-md bg-up/8" style={{ width: `${Math.min(100, h.pct)}%` }} />
                <span className="relative w-5 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                <span className={cn("relative font-mono", h.me && "font-semibold text-up")}>{shortAddr(h.address, 4, 4)}</span>
                {h.tags.map((t) => (
                  <span key={t} className="relative rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                    {t}
                  </span>
                ))}
                <span className="relative ml-auto font-mono font-medium">{h.pct < 0.01 ? "<0.01" : h.pct.toFixed(2)}%</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export type CoinCommentItem = { id: number; author: string; text: string; replyTo: number | null; at: number; isCreator?: boolean };

/** Thread like pump's: newest first, tap ↩ to reply (shows "#id"), posting needs the unlocked wallet. */
export function CommentBox({ items, loading, me, onPost, note }: { items: CoinCommentItem[]; loading?: boolean; me?: string; onPost: (text: string, replyTo: number | null) => Promise<void>; note?: string }) {
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onPost(body, replyTo);
      setText("");
      setReplyTo(null);
    } catch (e) {
      toast.error((e as Error).message || "发送失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mt-2.5 rounded-2xl bg-muted/60 p-2">
        {replyTo != null && (
          <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span>回复 #{replyTo}</span>
            <button type="button" onClick={() => setReplyTo(null)}>
              取消
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 280))} rows={text.length > 40 ? 3 : 1} placeholder={me ? "说点什么…" : "解锁钱包后可以发言"} disabled={!me} className="min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-[14px] outline-none" />
          <button type="button" aria-label="发送" disabled={!me || !text.trim() || busy} onClick={send} className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition active:scale-90 disabled:opacity-30">
            {busy ? <CircleNotch size={16} className="animate-spin" /> : <PaperPlaneRight size={16} weight="fill" />}
          </button>
        </div>
      </div>
      {note && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{note}</p>}
      {loading && items.length === 0 ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty text="还没人发言，来抢沙发" />
      ) : (
        <ul className="mt-2 divide-y divide-border/50">
          {items.map((c) => (
            <li key={c.id} className="py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <TokenAvatar symbol={c.author.slice(0, 2)} seed={c.author} size={18} className="rounded-full" />
                <span className={cn("font-mono", c.author === me && "font-semibold text-up")}>{shortAddr(c.author, 4, 4)}</span>
                {c.isCreator && <span className="rounded bg-up/12 px-1 text-[10px] font-semibold text-up">创建者</span>}
                <span>· {timeAgo(c.at)}</span>
                <span>#{c.id}</span>
                <button type="button" aria-label="回复" onClick={() => setReplyTo(c.id)} className="ml-auto p-1">
                  <ArrowBendUpLeft size={14} />
                </button>
              </div>
              <p className="mt-1 text-[14px] leading-relaxed break-words whitespace-pre-wrap">
                {c.replyTo != null && <span className="mr-1 text-[12px] text-up">#{c.replyTo}</span>}
                {c.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function AboutCard({ description, socials, creator, createdAt, rows }: { description?: string | null; socials?: { twitter?: string | null; telegram?: string | null; website?: string | null }; creator?: { address: string; name?: string | null; href?: string }; createdAt?: number; rows?: [string, React.ReactNode][] }) {
  const links = [
    { url: socials?.twitter, icon: XLogo, label: "X" },
    { url: socials?.telegram, icon: TelegramLogo, label: "Telegram" },
    { url: socials?.website, icon: Globe, label: "官网" },
  ].filter((l) => l.url && /^https?:\/\//.test(l.url));
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="text-[14px] font-semibold">简介</div>
      {description ? <p className="mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{description}</p> : <p className="mt-2 text-[13px] text-muted-foreground">创建者没写简介</p>}
      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((l) => (
            <a key={l.label} href={l.url!} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-[12px] font-medium">
              <l.icon size={14} />
              {l.label}
            </a>
          ))}
        </div>
      )}
      <dl className="mt-3 space-y-2 text-[13px]">
        {creator && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">创建者</dt>
            <dd className="truncate font-mono">
              {creator.href ? (
                <a href={creator.href} target="_blank" rel="noreferrer">
                  {creator.name || shortAddr(creator.address, 4, 4)}
                </a>
              ) : (
                creator.name || shortAddr(creator.address, 4, 4)
              )}
            </dd>
          </div>
        )}
        {createdAt != null && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">创建于</dt>
            <dd>{timeAgo(createdAt)}前</dd>
          </div>
        )}
        {rows?.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function KingBadge() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#f5a524]/15 px-2.5 py-1 text-[11px] font-semibold text-[#b77700] dark:text-[#f5c26b]">
      <Crown size={13} weight="fill" />
      山丘之王
    </span>
  );
}

export function ActionBar({ onBuy, onSell, sellDisabled, extra }: { onBuy: () => void; onSell: () => void; sellDisabled?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-[430px] bg-background/90 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:absolute">
      {extra}
      <div className="grid grid-cols-2 gap-2">
        <PrimaryButton tone="down" disabled={sellDisabled} onClick={onSell}>
          卖出
        </PrimaryButton>
        <PrimaryButton tone="up" onClick={onBuy}>
          买入
        </PrimaryButton>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-6">
      <CircleNotch size={22} className="animate-spin text-muted-foreground" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-[13px] text-muted-foreground">{text}</p>;
}
