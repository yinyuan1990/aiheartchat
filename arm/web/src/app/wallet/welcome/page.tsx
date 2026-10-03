"use client";

import Link from "next/link";
import { Lightning, ShieldCheck, Stack } from "@phosphor-icons/react";
import { WalletFrame } from "@/components/wallet/ui";

const POINTS = [
  { icon: ShieldCheck, title: "钱只在你手里", sub: "私钥加密保存在你的设备上，平台看不到也动不了" },
  { icon: Stack, title: "Arc 和主流 EVM 链", sub: "Arc、Ethereum、BNB Chain、Base、Arbitrum、Polygon 共用一个地址" },
  { icon: Lightning, title: "直接玩转 Arm", sub: "发币、买卖、快艇游戏，打开就能用" },
];

export default function WelcomePage() {
  return (
    <WalletFrame>
      <div className="relative mx-4 mt-6 overflow-hidden rounded-[32px] bg-[#0d0d0f] px-6 pt-10 pb-8 text-white dark:bg-[#17171c] dark:ring-1 dark:ring-white/10">
        <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.22),transparent_65%)]" />
        <div className="pointer-events-none absolute -bottom-28 -left-10 size-72 rounded-full bg-[radial-gradient(circle,rgba(120,160,255,0.2),transparent_65%)]" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.png" alt="" className="relative size-16 rounded-2xl shadow-lg" />
        <h1 className="relative mt-6 text-[30px] leading-tight font-semibold">
          你的链上钱包
          <br />
          <span className="text-white/55">安全、简单、自己掌控</span>
        </h1>
      </div>

      <ul className="mt-6 space-y-4 px-6">
        {POINTS.map((p) => (
          <li key={p.title} className="flex gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-card ring-1 ring-border">
              <p.icon size={22} weight="duotone" />
            </span>
            <div>
              <div className="text-[15px] font-semibold">{p.title}</div>
              <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{p.sub}</div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-auto space-y-2 px-4 pt-8 pb-[max(20px,env(safe-area-inset-bottom))]">
        <Link href="/wallet/create" className="flex h-14 w-full items-center justify-center rounded-2xl bg-primary text-[16px] font-semibold text-primary-foreground transition active:scale-[0.98]">
          创建新钱包
        </Link>
        <Link href="/wallet/import" className="flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold transition active:scale-[0.98]">
          我已有钱包，导入
        </Link>
        <p className="pt-2 text-center text-[11px] text-muted-foreground">继续即表示你已了解：助记词丢了，任何人都无法帮你找回资产</p>
      </div>
    </WalletFrame>
  );
}
