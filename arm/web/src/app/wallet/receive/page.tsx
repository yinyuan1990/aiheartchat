"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, ShareNetwork, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { WALLET_CHAINS } from "@/lib/wallet/chains";
import { copyText, shareText } from "@/lib/wallet/native";
import { cn } from "@/lib/utils";
import { useVault } from "@/components/wallet/wallet-context";
import { ChainGlyph, TopBar, WalletFrame, useQueryParam } from "@/components/wallet/ui";

export default function ReceivePage() {
  const { active, chain, setChain } = useVault();
  const deposit = useQueryParam("deposit") !== null;
  const address = active?.address ?? "";
  const [qr, setQr] = useState("");

  useEffect(() => {
    if (!address) return;
    let alive = true;
    QRCode.toDataURL(address, { margin: 1, width: 560, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } }).then((u) => alive && setQr(u));
    return () => {
      alive = false;
    };
  }, [address]);

  const copy = async () => {
    if (await copyText(address)) toast.success("地址已复制");
  };
  const share = async () => {
    if (!(await shareText(address))) void copy();
  };

  return (
    <WalletFrame>
      <TopBar back="/wallet" title={deposit ? "充值" : "收款"} />
      <div className="flex flex-1 flex-col px-4 pb-6">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {WALLET_CHAINS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setChain(c.key)}
              className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1.5 text-[13px] font-medium ring-1 transition", c.key === chain.key ? "bg-foreground text-background ring-foreground" : "bg-card ring-border")}
            >
              <ChainGlyph chain={c} size={22} />
              {c.name}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded-[28px] bg-card p-6 text-center ring-1 ring-border/60">
          <div className="flex items-center justify-center gap-2 text-[15px] font-semibold">
            <WalletDot address={address} size={22} />
            {active?.name}
          </div>
          <div className="relative mx-auto mt-5 size-[240px] rounded-3xl bg-white p-3 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.25)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr ? <img src={qr} alt="收款二维码" className="size-full" /> : <div className="size-full animate-pulse rounded-2xl bg-muted" />}
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white p-1">
              <ChainGlyph chain={chain} size={40} />
            </span>
          </div>
          <div className="mx-auto mt-5 max-w-[300px] font-mono text-[14px] leading-6 break-all">{address}</div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button type="button" onClick={copy} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-primary text-[15px] font-semibold text-primary-foreground transition active:scale-[0.98]">
              <Copy size={18} />
              复制地址
            </button>
            <button type="button" onClick={share} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[15px] font-semibold transition active:scale-[0.98]">
              <ShareNetwork size={18} />
              分享
            </button>
          </div>
        </div>

        <div className="mt-3 flex gap-2 rounded-2xl bg-[#f5a524]/10 p-4 text-[13px] leading-6 text-[#9a6200] dark:text-[#f5c26b]">
          <Warning size={18} weight="fill" className="mt-0.5 shrink-0" />
          <div>
            只能从 <b>{chain.name}</b> 转入（网络费用 {chain.chain.nativeCurrency.symbol} 付）。
            {chain.nativeIsUsdc ? " Arc 上的 USDC 同时用来付网络费，先充一点 USDC 就能开始交易。" : " 其它链的资产转到这里会丢失或需要跨链找回。"}
            {deposit && <div className="mt-1">从交易所提现时，提现网络选「{chain.name}」，地址填上面这个。</div>}
          </div>
        </div>
      </div>
    </WalletFrame>
  );
}
