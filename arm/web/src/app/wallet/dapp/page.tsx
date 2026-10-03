"use client";

import Link from "next/link";
import { CaretRight, Compass, GameController, RocketLaunch, Trophy } from "@phosphor-icons/react";
import { BottomNav, TopBar, WalletFrame } from "@/components/wallet/ui";

const ARM = [
  { href: "/", title: "Arm 首页", sub: "免费发币 · 78% 手续费归创作者", icon: Compass },
  { href: "/create", title: "发币", sub: "几分钟发一个 Arc 代币", icon: RocketLaunch },
  { href: "/games", title: "游戏探索", sub: "快艇冲冲冲 · 卖在山顶", icon: GameController },
  { href: "/rank", title: "排行榜", sub: "看看谁在赚钱", icon: Trophy },
];

export default function DappPage() {
  return (
    <WalletFrame>
      <TopBar title="DApp" />
      <div className="flex-1 px-4">
        <div className="rounded-[22px] bg-card p-4 text-[13px] leading-6 text-muted-foreground ring-1 ring-border/60">
          在心之音 App 里打开时，这里会是 DApp 浏览器：输入网址或点下面的应用，网页请求连接 / 签名都会弹出钱包确认。
        </div>
        <div className="mt-4 px-1 text-[13px] font-medium text-muted-foreground">Arm</div>
        <ul className="mt-2 divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
          {ARM.map((a) => (
            <li key={a.href}>
              <Link href={a.href} className="flex items-center gap-3 px-4 py-3.5">
                <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                  <a.icon size={20} weight="duotone" />
                </span>
                <span className="flex-1">
                  <span className="block text-[15px] font-semibold">{a.title}</span>
                  <span className="block text-[12px] text-muted-foreground">{a.sub}</span>
                </span>
                <CaretRight size={16} className="text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <BottomNav />
    </WalletFrame>
  );
}
