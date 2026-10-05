"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
import { AddressBook, CaretDown, ClipboardText, Info, Scan, ShieldCheck, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TRON_CHAIN, explorerTx, rpcOf, useNodes } from "@/lib/wallet/chains";
import { hasFeature, reportResult, returnsToApp, scanQr } from "@/lib/wallet/native";
import { transferMessage } from "@/lib/wallet/payee";
import { t } from "@/lib/wallet/i18n";
import { isTronEntry, pushRecent, useAddressBook } from "@/lib/wallet/address-book";
import { useAssets, type Asset } from "@/lib/wallet/assets";
import { SUN, estimateTronFee, isTronAddress, sendTron, waitTron } from "@/lib/wallet/tron";
import { useVault } from "@/components/wallet/wallet-context";
import { BookPicker, Result, Row, useScanSwitch, useSendLink, type Sent } from "@/components/wallet/send-parts";
import { BottomSheet, ChainGlyph, ChainPill, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const noSubscribe = () => () => {};
const fmt = (n: number, max = 6) => n.toLocaleString("en-US", { maximumFractionDigits: max });
const trxOf = (sun: bigint) => fmt(Number(sun) / SUN, 6);

/** "T…" as is, or a tron:T… URI */
function parseScannedTron(text: string): string | null {
  const s = text.trim().replace(/^tron:/i, "").split("?")[0];
  return isTronAddress(s) ? s : null;
}

export function TronSend() {
  useNodes();
  const { active, tronKey, address: from } = useVault();
  const { assets, loading } = useAssets(TRON_CHAIN, from);
  const link = useSendLink(TRON_CHAIN, assets, loading);
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === (assetId ?? link.wantedId)) ?? assets.find((a) => a.gas) ?? assets[0];
  const trxAsset = assets.find((a) => a.id === "native");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  useEffect(() => {
    if (!link.amount) return;
    const t = setTimeout(() => setAmount((cur) => cur || link.amount!), 0);
    return () => clearTimeout(t);
  }, [link.amount]);
  const [sheet, setSheet] = useState<null | "asset" | "confirm" | "book">(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const full = useAddressBook();
  const book = { contacts: full.contacts.filter((c) => isTronEntry(c.address)), recent: full.recent.filter(isTronEntry) };
  const canScan = useSyncExternalStore(noSubscribe, () => hasFeature("scan"), () => false);
  const switchToScanned = useScanSwitch();

  const wantedTo = link.to;
  useEffect(() => {
    if (!wantedTo || !isTronAddress(wantedTo)) return;
    const t = setTimeout(() => setTo((cur) => cur || wantedTo), 0);
    return () => clearTimeout(t);
  }, [wantedTo]);

  const toAddr = isTronAddress(to) ? to.trim() : undefined;
  const contact = toAddr ? book.contacts.find((c) => c.address === toAddr) : undefined;
  const selfSend = !!toAddr && toAddr === from;
  let value: bigint | null = null;
  try {
    value = asset && amount ? parseUnits(amount, asset.decimals) : null;
  } catch {
    value = null;
  }

  // fee depends on the recipient (new account / no token balance yet) and, for TRC20, the amount's energy
  const fees = useQuery({
    queryKey: ["wallet", "tron-fee", rpcOf(TRON_CHAIN), from, toAddr ?? from, asset?.trc20, asset?.trc20 ? String(value ?? 1n) : ""],
    enabled: !!from && !!asset,
    queryFn: () => estimateTronFee(from!, toAddr ?? from!, asset!.trc20, value && value > 0n ? value : 1n),
    staleTime: 20_000,
    retry: 1,
  });
  const fee = fees.data?.sun ?? null;
  const trxBal = trxAsset?.raw ?? 0n;
  const trxCost = (fee ?? 0n) + (asset && !asset.trc20 ? (value ?? 0n) : 0n);
  const over = !!asset && value != null && (asset.trc20 ? value > asset.raw : false);
  const trxShort = !!asset && fee != null && trxCost > trxBal;
  const blocker = over ? t("transfer.insufficient") : trxShort ? (asset?.trc20 ? t("cw.send.trxShortFee", { n: trxOf(fee!) }) : t("cw.send.trxShort", { n: trxOf(trxCost) })) : null;

  const setMax = (p: number) => {
    if (!asset) return;
    if (asset.trc20) return setAmount(formatUnits((asset.raw * BigInt(Math.round(p * 100))) / 100n, asset.decimals));
    if (fee == null) return void toast.info(t("cw.send.feeEstimating"));
    const room = ((trxBal - fee) * BigInt(Math.round(p * 100))) / 100n;
    setAmount(formatUnits(room > 0n ? room : 0n, 6));
  };

  const scan = async () => {
    let text: string | null;
    try {
      text = await scanQr();
    } catch (e) {
      return void toast.error((e as Error).message);
    }
    if (!text) return;
    const p = parseScannedTron(text);
    if (!p) return void (switchToScanned(text) || toast.error(t("cw.send.scanUnknownTron")));
    setTo(p);
  };
  const paste = async () => {
    try {
      setTo((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error(t("cw.send.clipboardFail"));
    }
  };

  const send = async () => {
    if (!asset || !toAddr || value == null || !fees.data || !from) return;
    let txid: string | null = null;
    try {
      const key = tronKey();
      txid = await sendTron(key, toAddr, asset.trc20 ? 0n : value, asset.trc20 ? { address: asset.trc20, amount: value } : undefined, fees.data.feeLimit || undefined);
      setSent({ hash: txid, status: "pending" });
      await waitTron(txid);
      pushRecent(toAddr);
      setSent({ hash: txid, status: "success" });
      if (returnsToApp()) {
        const proof = await key.account.signMessage({ message: transferMessage(txid, from, toAddr) });
        reportResult({ kind: "transfer", chain: TRON_CHAIN.key, token: asset.trc20 ?? "native", symbol: asset.symbol, decimals: asset.decimals, amount: value.toString(), to: toAddr, from, hash: txid, proof, req: link.req });
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (txid) setSent({ hash: txid, status: "error", error: msg });
      else toast.error(msg);
    }
  };

  if (!from) {
    return (
      <WalletFrame>
        <TopBar title={t("cw.send.title")} back="/wallet" right={<ChainPill chain={TRON_CHAIN} />} />
        <p className="px-6 py-16 text-center text-[14px] leading-7 text-muted-foreground">{t("cw.send.unlockFirst")}</p>
      </WalletFrame>
    );
  }

  return (
    <WalletFrame>
      <TopBar title={link.name ? t("cw.send.toName", { name: link.name }) : t("cw.send.title")} back="/wallet" right={<ChainPill chain={TRON_CHAIN} />} />

      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        {link.notHeld && <p className="rounded-2xl bg-[#d48806]/10 px-3.5 py-2.5 text-[12px] leading-5 text-[#b07005]">{t("cw.send.notHeld")}</p>}
        <button type="button" onClick={() => setSheet("asset")} disabled={loading} className="flex items-center gap-3 rounded-[22px] bg-card p-4 text-left ring-1 ring-border/60 transition active:scale-[0.99]">
          {asset ? (
            <>
              <div className="relative">
                <TokenAvatar symbol={asset.symbol} seed={asset.seed} logo={asset.logo} size={40} className="rounded-full" />
                <span className="absolute -right-0.5 -bottom-0.5">
                  <ChainGlyph chain={TRON_CHAIN} size={16} />
                </span>
              </div>
              <div className="flex-1">
                <div className="text-[15px] font-semibold">{asset.symbol}</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-foreground">{t("cw.send.balance", { n: fmt(asset.amount) })}</div>
              </div>
            </>
          ) : (
            <div className="h-10 flex-1 animate-pulse rounded-xl bg-muted" />
          )}
          <CaretDown size={16} weight="bold" className="text-muted-foreground" />
        </button>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">{t("cw.send.recipient")}</span>
            <span className="flex items-center gap-1.5">
              <button type="button" onClick={() => setSheet("book")} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                <AddressBook size={14} />
                {t("cw.send.book")}
              </button>
              {canScan && (
                <button type="button" onClick={scan} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                  <Scan size={14} />
                  {t("me.scan")}
                </button>
              )}
              <button type="button" onClick={paste} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                <ClipboardText size={14} />
                {t("cw.send.paste")}
              </button>
            </span>
          </div>
          <textarea
            value={to}
            onChange={(e) => setTo(e.target.value)}
            rows={2}
            spellCheck={false}
            autoCapitalize="none"
            placeholder={t("cw.send.tronPlaceholder")}
            className="mt-1 min-h-[48px] w-full resize-none bg-transparent font-mono text-[15px] leading-6 break-all outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
          />
          {to.trim() && !toAddr && <div className="text-[12px] text-down">{to.trim().startsWith("0x") ? t("cw.send.evmOnTron") : t("cw.send.badTronAddress")}</div>}
          {selfSend && <div className="text-[12px] text-[#d48806]">{t("cw.send.selfAddress")}</div>}
          {contact ? (
            <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
              <AddressBook size={14} weight="fill" />
              <span className="truncate">{t("cw.send.bookName", { name: contact.name })}</span>
            </div>
          ) : (
            toAddr &&
            book.recent.includes(toAddr) && (
              <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
                <ShieldCheck size={14} weight="fill" />
                {t("cw.send.sentBefore")}
              </div>
            )
          )}
          {book.recent.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {book.recent.map((r) => {
                const name = book.contacts.find((c) => c.address === r)?.name;
                return (
                  <button key={r} type="button" onClick={() => setTo(r)} className={cn("flex max-w-[160px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition active:scale-95", name ? "font-medium" : "font-mono", toAddr === r ? "border-foreground" : "border-border")}>
                    <WalletDot address={r} size={14} />
                    <span className="truncate">{name ?? shortAddr(r, 4, 4)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between text-[13px] font-medium text-muted-foreground">
            <span>{t("cw.send.amount")}</span>
            {asset?.priceUsd != null && value != null && <span className="font-mono">≈ ${(Number(amount) * asset.priceUsd).toFixed(2)}</span>}
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0"
              className={cn("w-0 flex-1 bg-transparent font-mono text-[36px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40", blocker && value && "text-down")}
            />
            <span className="text-[17px] font-semibold text-muted-foreground">{asset?.symbol}</span>
          </div>
          {blocker && value != null && value > 0n && <div className="text-[12px] text-down">{blocker}</div>}
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[0.25, 0.5, 0.75, 1].map((p) => (
              <button key={p} type="button" onClick={() => setMax(p)} className="h-9 rounded-xl bg-muted text-[13px] font-medium transition active:scale-95">
                {p === 1 ? t("cw.send.max") : `${p * 100}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
              {t("cw.send.fee")}
              <Info size={14} />
            </span>
            {fees.data ? <span className="font-mono text-[14px] font-semibold">{fee === 0n ? t("ai.free") : t("cw.send.approx", { amount: `${trxOf(fee!)} TRX` })}</span> : fees.isError ? <span className="text-[12px] text-down">{t("cw.send.estimateFailed")}</span> : <span className="h-3 w-16 animate-pulse rounded-full bg-border" />}
          </div>
          <p className="mt-3 text-[12px] leading-5 text-muted-foreground">
            {asset?.trc20 ? t("cw.send.tronFeeEnergy") : t("cw.send.tronFeeBandwidth")}
            {fees.data?.bandwidthFree ? t("cw.send.tronFreeBandwidth") : ""}
            {fees.data && fees.data.energy > 0
              ? t(fees.data.worstCase ? "cw.send.tronEnergyMax" : "cw.send.tronEnergy", { symbol: asset?.symbol ?? "", n: fees.data.energy.toLocaleString("en-US") }) +
                (fees.data.worstCase ? t("cw.send.tronWorstCase") : fees.data.energy > 100_000 ? t("cw.send.tronFirstTime") : "")
              : ""}
            {t("cw.send.sentenceEnd")}
          </p>
          {fees.data?.newAccount && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-5 text-[#d48806]">
              <Warning size={14} className="mt-0.5 shrink-0" />
              {t("cw.send.tronNewAccount")}
            </p>
          )}
          {asset?.trc20 && <p className="mt-2 text-[12px] text-muted-foreground">{t("cw.send.tronNeedTrx")}</p>}
        </div>
      </div>

      <div aria-hidden className="h-[calc(72px+max(16px,env(safe-area-inset-bottom)))] shrink-0 sm:hidden" />
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[430px] bg-background/90 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:sticky">
        <PrimaryButton disabled={!toAddr || !value || !!blocker || fee == null} onClick={() => setSheet("confirm")}>
          {t("common.next")}
        </PrimaryButton>
      </div>

      <BottomSheet open={sheet === "asset"} onClose={() => setSheet(null)}>
        <div className="mb-3 text-center text-[17px] font-semibold">{t("cw.send.pickAsset")}</div>
        <ul className="space-y-1">
          {assets.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  setAssetId(a.id);
                  setAmount("");
                  setSheet(null);
                }}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-3", a.id === asset?.id ? "bg-muted" : "hover:bg-muted/60")}
              >
                <TokenAvatar symbol={a.symbol} seed={a.seed} logo={a.logo} size={36} className="rounded-full" />
                <span className="flex-1 text-left">
                  <span className="block text-[15px] font-semibold">{a.symbol}</span>
                  {a.trc20 && <span className="block font-mono text-[11px] text-muted-foreground">{shortAddr(a.trc20, 4, 4)}</span>}
                </span>
                <span className="font-mono text-[14px]">{fmt(a.amount, 4)}</span>
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      <BottomSheet open={sheet === "book"} onClose={() => setSheet(null)}>
        {sheet === "book" && (
          <BookPicker
            contacts={book.contacts}
            recent={book.recent}
            current={toAddr}
            onPick={(a) => {
              setTo(a);
              setSheet(null);
            }}
          />
        )}
      </BottomSheet>

      <BottomSheet open={sheet === "confirm"} onClose={() => (sent?.status === "pending" ? undefined : (setSheet(null), setSent(null)))}>
        {sent ? (
          <Result sent={sent} explorer={explorerTx(TRON_CHAIN, sent.hash)} to={toAddr} saved={!!contact} />
        ) : (
          <TronConfirm asset={asset} amount={amount} fromName={active?.name} from={from} to={toAddr} toName={contact?.name} fee={fee != null ? (fee === 0n ? t("ai.free") : t("cw.send.approx", { amount: `${trxOf(fee)} TRX` })) : "—"} onCancel={() => setSheet(null)} onSend={send} />
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

function TronConfirm({ asset, amount, fromName, from, to, toName, fee, onCancel, onSend }: { asset?: Asset; amount: string; fromName?: string; from: string; to?: string; toName?: string; fee: string; onCancel: () => void; onSend: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="text-center text-[17px] font-semibold">{t("cw.send.confirmTitle")}</div>
      <div className="mt-5 text-center">
        <div className="font-mono text-[34px] font-semibold tracking-tight">
          {amount} <span className="text-[18px] text-muted-foreground">{asset?.symbol}</span>
        </div>
        {asset?.priceUsd != null && <div className="mt-1 font-mono text-[13px] text-muted-foreground">≈ ${(Number(amount) * asset.priceUsd).toFixed(2)}</div>}
      </div>
      <dl className="mt-5 divide-y divide-border/60 rounded-[20px] bg-muted/60 px-4 text-[14px]">
        <Row label={t("cw.send.from")}>
          <span className="flex items-center gap-1.5">
            <WalletDot address={from} size={16} />
            {fromName}
            <span className="font-mono text-muted-foreground">{shortAddr(from, 4, 4)}</span>
          </span>
        </Row>
        <Row label={t("cw.send.to")}>
          <span className="flex max-w-[230px] flex-col items-end text-right">
            {toName && <span className="text-[14px] font-medium">{toName}</span>}
            <span className="font-mono text-[13px] break-all">{to}</span>
          </span>
        </Row>
        <Row label={t("cw.send.network")}>
          <span className="flex items-center gap-1.5">
            <ChainGlyph chain={TRON_CHAIN} size={16} />
            TRON
          </span>
        </Row>
        {asset?.trc20 && (
          <Row label={t("cw.send.tokenContract")}>
            <span className="font-mono text-[13px]">{shortAddr(asset.trc20, 6, 6)}</span>
          </Row>
        )}
        <Row label={t("cw.send.fee")}>
          <span className="font-mono">{fee}</span>
        </Row>
      </dl>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-muted-foreground">
        <Warning size={14} className="mt-0.5 shrink-0" />
        {t("cw.send.irreversibleTron")}
      </p>
      <div className="mt-4 grid grid-cols-[1fr_2fr] gap-2">
        <GhostButton onClick={onCancel}>{t("common.cancel")}</GhostButton>
        <PrimaryButton
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSend();
            setBusy(false);
          }}
        >
          {busy ? t("cw.send.signing") : t("cw.send.confirmSend")}
        </PrimaryButton>
      </div>
    </>
  );
}
