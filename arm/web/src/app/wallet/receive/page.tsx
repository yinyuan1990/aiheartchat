"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { parseUnits } from "viem";
import { ChatCircleText, Copy, ShareNetwork, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { WALLET_CHAINS, isSolana, isTon, isTron } from "@/lib/wallet/chains";
import { canSharePayreq, copyText, shareCard, shareText } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
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
  const ton = isTon(chain);
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
    if (await copyText(address)) toast.success(t("card.addressCopied"));
  };
  const share = async () => {
    if (!(await shareText(address))) void copy();
  };

  return (
    <WalletFrame>
      <TopBar back="/wallet" title={deposit ? t("cw.home.deposit") : t("cw.home.receive")} />
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
            {t("cw.receive.solKeyNoAddr", { name: active?.name ?? "" })}
            <br />
            {t("cw.receive.switchForSol")}
          </div>
        ) : tron && !address ? (
          <div className="mt-4 rounded-[28px] bg-card p-6 text-center text-[14px] leading-7 text-muted-foreground ring-1 ring-border/60">{t("cw.receive.unlockTron")}</div>
        ) : ton && !address ? (
          <div className="mt-4 rounded-[28px] bg-card p-6 text-center text-[14px] leading-7 text-muted-foreground ring-1 ring-border/60">
            {active?.kind === "key" ? (
              <>
                {t("cw.receive.tonKeyNoAddr", { name: active?.name ?? "" })}
                <br />
                {t("cw.receive.switchForTon")}
              </>
            ) : (
              t("cw.receive.unlockTon")
            )}
          </div>
        ) : (
        <div className="mt-4 rounded-[28px] bg-card p-6 text-center ring-1 ring-border/60">
          <div className="flex items-center justify-center gap-2 text-[15px] font-semibold">
            <WalletDot address={address} size={22} />
            {active?.name}
          </div>
          <div className="relative mx-auto mt-5 size-[240px] rounded-3xl bg-white p-3 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.25)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr ? <img src={qr} alt={t("cw.receive.qrAlt")} className="size-full" /> : <div className="size-full animate-pulse rounded-2xl bg-muted" />}
            <span className="absolute inset-0 m-auto size-fit rounded-full bg-white p-1">
              <ChainGlyph chain={chain} size={40} />
            </span>
          </div>
          <div className="mx-auto mt-5 max-w-[300px] font-mono text-[14px] leading-6 break-all">{address}</div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button type="button" onClick={copy} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-primary text-[15px] font-semibold text-primary-foreground transition active:scale-[0.98]">
              <Copy size={18} />
              {t("cw.receive.copyAddress")}
            </button>
            <button type="button" onClick={share} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[15px] font-semibold transition active:scale-[0.98]">
              <ShareNetwork size={18} />
              {t("common.share")}
            </button>
          </div>
          {canChat && (
            <button type="button" onClick={() => setSheet(true)} className="mt-2 flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-[#f59e0b] text-[15px] font-semibold text-white transition active:scale-[0.98]">
              <ChatCircleText size={18} />
              {t("cw.receive.toChat")}
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
            {t("cw.receive.onlyFromBefore")}<b>{chain.name}</b>{t("cw.receive.onlyFromAfter", { symbol: chain.chain.nativeCurrency.symbol })}
            {chain.nativeIsUsdc
              ? t("cw.receive.noteArc")
              : sol
                ? t("cw.receive.noteSol")
                : tron
                  ? t("cw.receive.noteTron")
                  : ton
                    ? t("cw.receive.noteTon")
                    : t("cw.receive.noteOther")}
            {deposit && <div className="mt-1">{t("cw.receive.depositHint", { chain: chain.name })}</div>}
          </div>
        </div>
      </div>
    </WalletFrame>
  );
}

const noSubscribe = () => () => {};
const tokenIdOf = (a: Asset) => a.token ?? a.mint ?? a.trc20 ?? a.jetton ?? "native";

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
      <div className="mb-1 text-center text-[17px] font-semibold">{t("cw.receive.payreqTitle")}</div>
      <p className="mb-4 text-center text-[12px] text-muted-foreground">{t("cw.receive.payreqDesc", { chain: chainName })}</p>
      <div className="text-[13px] font-medium text-muted-foreground">{t("cw.receive.tokenOptional")}</div>
      <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1">
        <button type="button" onClick={() => setAssetId(null)} className={cn("h-9 shrink-0 rounded-full px-3 text-[13px] font-medium ring-1", !asset ? "bg-foreground text-background ring-foreground" : "bg-card ring-border")}>
          {t("cw.receive.anyToken")}
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
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder={t("cw.receive.amountOptional")} className="min-w-0 flex-1 bg-transparent font-mono text-[16px] outline-none" />
          <span className="text-[14px] font-semibold text-muted-foreground">{asset.symbol}</span>
        </label>
      )}
      {bad && <div className="mt-1 text-[12px] text-down">{t("cw.receive.badAmount")}</div>}
      <label className="mt-3 flex h-12 items-center rounded-2xl bg-muted px-3.5">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder={t("cw.receive.notePlaceholder")} className="min-w-0 flex-1 bg-transparent text-[15px] outline-none" />
      </label>
      <PrimaryButton className="mt-4" disabled={bad} onClick={send}>
        {t("cw.receive.pickChat")}
      </PrimaryButton>
    </>
  );
}
