"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { parseUnits } from "viem";
import { ChatCircleText, Copy, ShareNetwork, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { WALLET_CHAINS, isSolana, isTron } from "@/lib/wallet/chains";
import { canSharePayreq, copyText, shareCard, shareText } from "@/lib/wallet/native";
import { useAssets, type Asset } from "@/lib/wallet/assets";
import { cn } from "@/lib/utils";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, ChainGlyph, PrimaryButton, TopBar, WalletFrame, useQueryParam } from "@/components/wallet/ui";

export default function ReceivePage() {
  const { active, chain, setChain, address: chainAddress } = useVault();
  const deposit = useQueryParam("deposit") !== null;
  const address = chainAddress ?? "";
  const sol = isSolana(chain);
  const tron = isTron(chain);
  const [qr, setQr] = useState("");
  const [sheet, setSheet] = useState(false);
  const canChat = useSyncExternalStore(noSubscribe, canSharePayreq, () => false);

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

        {sol && !address ? (
          <div className="mt-4 rounded-[28px] bg-card p-6 text-center text-[14px] leading-7 text-muted-foreground ring-1 ring-border/60">
            「{active?.name}」是用私钥导入的，没有 Solana 地址。
            <br />
            请切换到助记词钱包收 SOL。
          </div>
        ) : tron && !address ? (
          <div className="mt-4 rounded-[28px] bg-card p-6 text-center text-[14px] leading-7 text-muted-foreground ring-1 ring-border/60">解锁一次钱包后显示波场地址。</div>
        ) : (
        <div className="mt-4 rounded-[28px] bg-card p-6 text-center ring-1 ring-border/60">
          <div className="flex items-center justify-center gap-2 text-[15px] font-semibold">
            <WalletDot address={address} size={22} />
            {active?.name}
          </div>
          <div className="relative mx-auto mt-5 size-[240px] rounded-3xl bg-white p-3 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.25)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr ? <img src={qr} alt="收款二维码" className="size-full" /> : <div className="size-full animate-pulse rounded-2xl bg-muted" />}
            <span className="absolute inset-0 m-auto size-fit rounded-full bg-white p-1">
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
          {canChat && (
            <button type="button" onClick={() => setSheet(true)} className="mt-2 flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-[#f59e0b] text-[15px] font-semibold text-white transition active:scale-[0.98]">
              <ChatCircleText size={18} />
              发到聊天（好友 / 群 / 频道）
            </button>
          )}
        </div>
        )}
        <BottomSheet open={sheet} onClose={() => setSheet(false)}>
          {sheet && <PayreqForm chainKey={chain.key} chainName={chain.name} address={address} onSent={() => setSheet(false)} />}
        </BottomSheet>

        <div className="mt-3 flex gap-2 rounded-2xl bg-[#f5a524]/10 p-4 text-[13px] leading-6 text-[#9a6200] dark:text-[#f5c26b]">
          <Warning size={18} weight="fill" className="mt-0.5 shrink-0" />
          <div>
            只能从 <b>{chain.name}</b> 转入（网络费用 {chain.chain.nativeCurrency.symbol} 付）。
            {chain.nativeIsUsdc
              ? " Arc 上的 USDC 同时用来付网络费，先充一点 USDC 就能开始交易。"
              : sol
                ? " 这个地址收 SOL 和 Solana 上的代币（USDC、pump 币等）。和 EVM 的 0x 地址不通用，别从以太坊 / BNB 链往这里转。"
                : tron
                  ? " 这个 T 开头的地址收 TRX 和 TRC20 代币（USDT 等）。交易所提 USDT 时网络选 TRC20 / TRON，选错（ERC20、BEP20）会丢。"
                  : " 其它链的资产转到这里会丢失或需要跨链找回。"}
            {deposit && <div className="mt-1">从交易所提现时，提现网络选「{chain.name}」，地址填上面这个。</div>}
          </div>
        </div>
      </div>
    </WalletFrame>
  );
}

const noSubscribe = () => () => {};
const tokenIdOf = (a: Asset) => a.token ?? a.mint ?? a.trc20 ?? "native";

/** 收款发到聊天：币种、金额都可以不填（对方自己选），选好后由 App 弹会话选择发出去 */
function PayreqForm({ chainKey, chainName, address, onSent }: { chainKey: string; chainName: string; address: string; onSent: () => void }) {
  const { chain } = useVault();
  const { assets } = useAssets(chain, address);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const asset = assets.find((a) => a.id === assetId) ?? null;
  let raw: bigint | null = null;
  try {
    raw = asset && amount && Number(amount) > 0 ? parseUnits(amount, asset.decimals) : null;
  } catch {
    raw = null;
  }
  const bad = !!amount && raw == null;
  const send = () => {
    shareCard({
      kind: "payreq",
      chain: chainKey,
      address,
      ...(asset ? { token: tokenIdOf(asset), symbol: asset.symbol, decimals: asset.decimals } : {}),
      ...(raw != null ? { amount: raw.toString() } : {}),
      note: note.trim().slice(0, 100),
    });
    onSent();
  };
  return (
    <>
      <div className="mb-1 text-center text-[17px] font-semibold">发收款到聊天</div>
      <p className="mb-4 text-center text-[12px] text-muted-foreground">对方看到二维码和 {chainName} 地址，点「转账」直接付款</p>
      <div className="text-[13px] font-medium text-muted-foreground">币种（可不选）</div>
      <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1">
        <button type="button" onClick={() => setAssetId(null)} className={cn("h-9 shrink-0 rounded-full px-3 text-[13px] font-medium ring-1", !asset ? "bg-foreground text-background ring-foreground" : "bg-card ring-border")}>
          不指定
        </button>
        {assets.map((a) => (
          <button key={a.id} type="button" onClick={() => setAssetId(a.id)} className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1.5 text-[13px] font-medium ring-1", asset?.id === a.id ? "bg-foreground text-background ring-foreground" : "bg-card ring-border")}>
            <TokenAvatar symbol={a.symbol} seed={a.seed} logo={a.logo} size={22} className="rounded-full" />
            {a.symbol}
          </button>
        ))}
      </div>
      {asset && (
        <label className="mt-3 flex h-12 items-center gap-2 rounded-2xl bg-muted px-3.5">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="金额（可不填）" className="min-w-0 flex-1 bg-transparent font-mono text-[16px] outline-none" />
          <span className="text-[14px] font-semibold text-muted-foreground">{asset.symbol}</span>
        </label>
      )}
      {bad && <div className="mt-1 text-[12px] text-down">金额格式不对</div>}
      <label className="mt-3 flex h-12 items-center rounded-2xl bg-muted px-3.5">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="备注（可不填），例如：AA 饭钱" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none" />
      </label>
      <PrimaryButton className="mt-4" disabled={bad} onClick={send}>
        选择聊天并发送
      </PrimaryButton>
    </>
  );
}
