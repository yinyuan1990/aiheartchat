"use client";

import { useState } from "react";
import { ArrowDown, CaretDown, CaretUp, DotsThree, Info, LockSimple, PenNib, SealCheck, ShieldWarning, Warning, X } from "@phosphor-icons/react";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { fmtNum, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CHAINS, TOKEN, USDC_LOGO, WALLET } from "@/components/wallet/mock";
import { BottomSheet, ChainGlyph, GhostButton, PrimaryButton, WalletFrame, useQueryParam } from "@/components/wallet/ui";

type Kind = "sign" | "tx" | "approve";

const MESSAGE = `Arm · Speedboat\nWallet: ${WALLET.address}\nTime: 1790991258175`;

export default function SignPreview() {
  const q = useQueryParam("kind");
  const [kindState, setKind] = useState<Kind | null>(null);
  const kind: Kind = kindState ?? (q === "tx" || q === "approve" ? q : "sign");
  const [open, setOpen] = useState(true);

  return (
    <WalletFrame className="bg-[#f6f6f6]">
      <BrowserChrome host={kind === "approve" ? "claim-arc-airdrop.xyz" : "arm.yyheart.com"} />
      <FakeDapp />

      <div className="absolute top-20 right-3 left-3 z-10 flex justify-center gap-1 sm:top-24">
        {(["sign", "tx", "approve"] as const).map((k) => (
          <button key={k} type="button" onClick={() => { setKind(k); setOpen(true); }} className="rounded-full bg-black/70 px-3 py-1 text-[11px] text-white">
            {{ sign: "签名", tx: "交易", approve: "授权" }[k]}
          </button>
        ))}
      </div>

      <BottomSheet open={open} onClose={() => setOpen(false)}>
        <Origin trusted={kind !== "approve"} />
        {kind === "sign" && <SignBody />}
        {kind === "tx" && <TxBody />}
        {kind === "approve" && <ApproveBody />}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <GhostButton onClick={() => setOpen(false)}>拒绝</GhostButton>
          <PrimaryButton tone={kind === "approve" ? "danger" : "default"}>{kind === "sign" ? "签名" : "确认"}</PrimaryButton>
        </div>
      </BottomSheet>
    </WalletFrame>
  );
}

function BrowserChrome({ host }: { host: string }) {
  return (
    <div className="flex h-14 items-center gap-2 bg-white px-3 text-[#111]">
      <X size={20} />
      <div className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-[#f1f1f1] text-[13px]">
        <LockSimple size={13} weight="fill" className="text-[#26a69a]" />
        {host}
      </div>
      <DotsThree size={22} weight="bold" />
    </div>
  );
}

function FakeDapp() {
  return (
    <div className="space-y-3 p-4 opacity-90">
      <div className="h-36 rounded-3xl bg-gradient-to-br from-[#4f46e5] to-[#2563eb]" />
      <div className="h-24 rounded-3xl bg-white" />
      <div className="h-24 rounded-3xl bg-white" />
      <div className="h-24 rounded-3xl bg-white" />
    </div>
  );
}

function Origin({ trusted }: { trusted: boolean }) {
  if (!trusted) {
    return (
      <div className="flex flex-col items-center text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-down/10 text-down ring-1 ring-down/30">
          <Warning size={26} weight="fill" />
        </span>
        <div className="mt-2 text-[15px] font-semibold">claim-arc-airdrop.xyz</div>
        <div className="text-[12px] text-down">首次访问 · 不在推荐列表里</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.png" alt="" className="size-14 rounded-2xl shadow-sm ring-1 ring-border" />
      <div className="mt-2 flex items-center gap-1 text-[15px] font-semibold">
        arm.yyheart.com
        <SealCheck size={16} weight="fill" className="text-up" />
      </div>
      <div className="text-[12px] text-muted-foreground">Arm 官方 · 已连接</div>
    </div>
  );
}

function Account() {
  const chain = CHAINS[0];
  return (
    <div className="flex items-center justify-between rounded-2xl bg-muted/60 px-3.5 py-3 text-[13px]">
      <span className="flex items-center gap-2">
        <WalletDot address={WALLET.address} size={20} />
        <span className="font-medium">{WALLET.name}</span>
        <span className="font-mono text-muted-foreground">{shortAddr(WALLET.address, 4, 4)}</span>
      </span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <ChainGlyph chain={chain} size={16} />
        {chain.name}
      </span>
    </div>
  );
}

function SignBody() {
  const [full, setFull] = useState(false);
  return (
    <>
      <h2 className="mt-4 flex items-center justify-center gap-1.5 text-[18px] font-semibold">
        <PenNib size={18} weight="bold" />
        签名请求
      </h2>
      <div className="mt-4 space-y-2">
        <Account />
        <div className="rounded-2xl bg-muted/60 px-3.5 py-3">
          <div className="flex items-center justify-between text-[12px] text-muted-foreground">
            签名内容
            <button type="button" onClick={() => setFull((v) => !v)} className="flex items-center gap-0.5">
              {full ? "收起" : "展开"}
              {full ? <CaretUp size={12} /> : <CaretDown size={12} />}
            </button>
          </div>
          <pre className={cn("mt-1.5 font-mono text-[12.5px] leading-5 break-all whitespace-pre-wrap", !full && "line-clamp-3")}>{MESSAGE}</pre>
        </div>
      </div>
      <p className="mt-3 flex items-start gap-1.5 rounded-2xl bg-up/10 px-3.5 py-2.5 text-[12px] leading-5 text-up">
        <Info size={14} className="mt-0.5 shrink-0" />
        这是登录签名：不花钱，也不会授权任何人动你的资产。
      </p>
    </>
  );
}

function TxBody() {
  const [raw, setRaw] = useState(false);
  const usdc = 10;
  const out = (usdc * 0.99) / TOKEN.price;
  return (
    <>
      <h2 className="mt-4 text-center text-[18px] font-semibold">确认交易</h2>
      <div className="mt-4 space-y-2">
        <div className="rounded-[20px] bg-muted/60 p-4">
          <div className="text-[12px] text-muted-foreground">买入代币</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <TokenAvatar symbol="USDC" seed="0x3600000000000000000000000000000000000000" logo={USDC_LOGO} size={30} className="rounded-full" />
              <span className="font-mono text-[20px] font-semibold text-down">−{usdc}</span>
            </span>
            <span className="text-[14px] font-semibold">USDC</span>
          </div>
          <div className="my-2 flex justify-center text-muted-foreground">
            <ArrowDown size={16} weight="bold" />
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <TokenAvatar symbol={TOKEN.symbol} seed={TOKEN.address} logo={TOKEN.logo} size={30} className="rounded-full" />
              <span className="font-mono text-[20px] font-semibold text-up">+{fmtNum(out, 2)}</span>
            </span>
            <span className="text-[14px] font-semibold">{TOKEN.symbol}</span>
          </div>
          <div className="mt-2 text-right text-[11px] text-muted-foreground">最少得到 {fmtNum(out * 0.98, 2)}（滑点 2%）</div>
        </div>
        <Account />
        <dl className="divide-y divide-border/60 rounded-2xl bg-muted/60 px-3.5 text-[13px]">
          <div className="flex justify-between py-2.5">
            <dt className="text-muted-foreground">合约</dt>
            <dd className="flex items-center gap-1">
              Arm 路由
              <SealCheck size={14} weight="fill" className="text-up" />
            </dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="text-muted-foreground">网络费</dt>
            <dd className="font-mono">≈ 0.0031 USDC</dd>
          </div>
          <button type="button" onClick={() => setRaw((v) => !v)} className="flex w-full justify-between py-2.5 text-muted-foreground">
            原始数据
            {raw ? <CaretUp size={14} /> : <CaretDown size={14} />}
          </button>
          {raw && <pre className="pb-3 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground">exactInputSingle(0x3600…0000 → 0x5AF2…25f6, fee 10000, amountIn 10000000, minOut …)</pre>}
        </dl>
      </div>
    </>
  );
}

function ApproveBody() {
  return (
    <>
      <h2 className="mt-4 flex items-center justify-center gap-1.5 text-[18px] font-semibold text-down">
        <ShieldWarning size={20} weight="fill" />
        无限授权
      </h2>
      <div className="mt-4 space-y-2">
        <div className="rounded-[20px] border border-down/30 bg-down/8 p-4 text-[13px] leading-6">
          <div className="flex items-center gap-2 font-semibold">
            <TokenAvatar symbol="USDC" seed="0x3600000000000000000000000000000000000000" logo={USDC_LOGO} size={26} className="rounded-full" />
            允许对方随时转走你全部的 USDC
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-foreground/80">
            <li>授权对象：<span className="font-mono">0x9f3a…c210</span>（未验证合约）</li>
            <li>数量：无限</li>
          </ul>
        </div>
        <Account />
        <p className="flex items-start gap-1.5 rounded-2xl bg-muted/60 px-3.5 py-2.5 text-[12px] leading-5 text-muted-foreground">
          <Warning size={14} className="mt-0.5 shrink-0 text-down" />
          不认识这个网站就拒绝。确实要用的话，建议改成只授权这次需要的数量。
        </p>
        <button type="button" className="w-full rounded-2xl bg-muted/60 py-2.5 text-[13px] font-medium">改为只授权 10 USDC</button>
      </div>
    </>
  );
}
