"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
import { AddressBook, CaretDown, ClipboardText, Info, Scan, ShieldCheck, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TON_CHAIN, explorerAddr, explorerTx, rpcOf, useNodes } from "@/lib/wallet/chains";
import { hasFeature, reportResult, returnsToApp, scanQr } from "@/lib/wallet/native";
import { transferMessage } from "@/lib/wallet/payee";
import { isTonEntry, pushRecent, useAddressBook } from "@/lib/wallet/address-book";
import { useAssets, type Asset } from "@/lib/wallet/assets";
import { parseScannedTon } from "@/lib/wallet/scan";
import { JETTON_ATTACH, estimateTonFee, isTonAddress, sameTonAddress, sendTon, signTonText, tonOf, waitTon } from "@/lib/wallet/ton";
import { useVault } from "@/components/wallet/wallet-context";
import { BookPicker, Result, Row, useScanSwitch, useSendLink, type Sent } from "@/components/wallet/send-parts";
import { BottomSheet, ChainGlyph, ChainPill, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const noSubscribe = () => () => {};
const fmt = (n: number, max = 6) => n.toLocaleString("en-US", { maximumFractionDigits: max });
const MEMO_MAX = 120;

export function TonSend() {
  useNodes();
  const { active, tonKey, address: from } = useVault();
  const { assets, loading } = useAssets(TON_CHAIN, from);
  const link = useSendLink(TON_CHAIN, assets, loading);
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === (assetId ?? link.wantedId)) ?? assets.find((a) => a.gas) ?? assets[0];
  const gram = assets.find((a) => a.id === "native");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  /** 「最大」on GRAM: send the whole balance, fees come out of it */
  const [all, setAll] = useState(false);
  const [memo, setMemo] = useState("");
  useEffect(() => {
    if (!link.amount) return;
    const t = setTimeout(() => setAmount((cur) => cur || link.amount!), 0);
    return () => clearTimeout(t);
  }, [link.amount]);
  const [sheet, setSheet] = useState<null | "asset" | "confirm" | "book">(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const full = useAddressBook();
  const book = { contacts: full.contacts.filter((c) => isTonEntry(c.address)), recent: full.recent.filter(isTonEntry) };
  const canScan = useSyncExternalStore(noSubscribe, () => hasFeature("scan"), () => false);
  const switchToScanned = useScanSwitch();
  useEffect(() => {
    if (!link.memo) return;
    const t = setTimeout(() => setMemo((cur) => cur || link.memo!), 0);
    return () => clearTimeout(t);
  }, [link.memo]);

  const wantedTo = link.to;
  useEffect(() => {
    if (!wantedTo || !isTonAddress(wantedTo)) return;
    const t = setTimeout(() => setTo((cur) => cur || wantedTo), 0);
    return () => clearTimeout(t);
  }, [wantedTo]);

  const toAddr = isTonAddress(to) ? to.trim() : undefined;
  const contact = toAddr ? book.contacts.find((c) => sameTonAddress(c.address, toAddr)) : undefined;
  const selfSend = !!toAddr && sameTonAddress(toAddr, from);
  const memoBytes = new TextEncoder().encode(memo).length;
  const memoBad = memoBytes > MEMO_MAX;
  let value: bigint | null = null;
  try {
    value = asset && amount ? parseUnits(amount, asset.decimals) : null;
  } catch {
    value = null;
  }
  const sendAll = all && !asset?.jetton;

  const fees = useQuery({
    queryKey: ["wallet", "ton-fee", rpcOf(TON_CHAIN), from, toAddr ?? from, asset?.jetton ?? "", !!memo, sendAll],
    enabled: !!from && !!asset && !memoBad,
    queryFn: () => estimateTonFee(tonKey(), toAddr ?? from!, value && value > 0n ? value : 1n, { jetton: asset!.jetton, comment: memo || undefined, all: sendAll }),
    staleTime: 20_000,
    retry: 1,
  });
  const fee = fees.data?.nano ?? null;
  const gramBal = gram?.raw ?? 0n;
  const gramCost = (fee ?? 0n) + (asset?.jetton ? JETTON_ATTACH : sendAll ? 0n : (value ?? 0n));
  const over = !!asset && value != null && (asset.jetton ? value > asset.raw : sendAll ? fee != null && gramBal <= fee : false);
  const gramShort = !!asset && fee != null && gramCost > gramBal;
  const blocker = over ? (sendAll ? "余额不够付网络费" : "余额不足") : gramShort ? (asset?.jetton ? `GRAM 不够（转代币要约 ${tonOf(gramCost, 4)} GRAM：网络费 + 附带 0.05）` : `GRAM 不够（需要 ${tonOf(gramCost, 4)} GRAM，含网络费）`) : memoBad ? "备注太长" : null;

  const setMax = (p: number) => {
    if (!asset) return;
    setAll(false);
    if (asset.jetton) return setAmount(formatUnits((asset.raw * BigInt(Math.round(p * 100))) / 100n, asset.decimals));
    if (p === 1) {
      // the whole balance goes out (send mode 128); the amount shown is what is left after the fee
      setAll(true);
      return setAmount(formatUnits(gramBal - (fee ?? 0n) > 0n ? gramBal - (fee ?? 0n) : 0n, 9));
    }
    if (fee == null) return void toast.info("网络费还在估算，稍等一下");
    const room = ((gramBal - fee) * BigInt(Math.round(p * 100))) / 100n;
    setAmount(formatUnits(room > 0n ? room : 0n, 9));
  };

  const scan = async () => {
    let text: string | null;
    try {
      text = await scanQr();
    } catch (e) {
      return void toast.error((e as Error).message);
    }
    if (!text) return;
    const p = parseScannedTon(text);
    if (!p) return void (switchToScanned(text) || toast.error("没认出 TON 收款地址，请换一个二维码或手动粘贴"));
    setTo(p.to);
    if (p.text) setMemo(p.text.slice(0, MEMO_MAX));
    const want = p.jetton ? assets.find((a) => a.jetton && sameTonAddress(a.jetton, p.jetton)) : gram;
    if (p.jetton && !want) toast.info("二维码要的代币不在你的资产里，先在资产页添加");
    if (want) {
      setAssetId(want.id);
      setAll(false);
      if (p.raw != null) setAmount(formatUnits(p.raw, want.decimals));
    }
  };
  const paste = async () => {
    try {
      setTo((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error("无法读取剪贴板，请手动粘贴");
    }
  };

  const send = async () => {
    if (!asset || !toAddr || value == null || !fees.data || !from) return;
    let started = false;
    try {
      const key = tonKey();
      const s = await sendTon(key, toAddr, value, { jetton: asset.jetton, comment: memo || undefined, all: sendAll });
      started = true;
      setSent({ hash: key.address, status: "pending" });
      const hash = await waitTon(key.address, s);
      pushRecent(toAddr);
      setSent({ hash, status: "success" });
      if (returnsToApp()) {
        const proof = signTonText(key, transferMessage(hash, key.address, toAddr));
        reportResult({ kind: "transfer", chain: TON_CHAIN.key, token: asset.jetton ?? "native", symbol: asset.symbol, decimals: asset.decimals, amount: value.toString(), to: toAddr, from: key.address, hash, proof, req: link.req });
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (started) setSent((cur) => ({ hash: cur?.hash ?? from, status: "error", error: msg }));
      else toast.error(msg);
    }
  };

  if (!from) {
    return (
      <WalletFrame>
        <TopBar title="转账" back="/wallet" right={<ChainPill chain={TON_CHAIN} />} />
        <p className="px-6 py-16 text-center text-[14px] leading-7 text-muted-foreground">{active?.kind === "key" ? `「${active.name}」是用私钥导入的，没有 TON 账户，请切换到助记词钱包。` : "请先解锁钱包。"}</p>
      </WalletFrame>
    );
  }

  const feeText = fee != null ? `约 ${tonOf(fee, 4)} GRAM` : "—";
  return (
    <WalletFrame>
      <TopBar title={link.name ? `转账给 ${link.name}` : "转账"} back="/wallet" right={<ChainPill chain={TON_CHAIN} />} />

      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        <button type="button" onClick={() => setSheet("asset")} disabled={loading} className="flex items-center gap-3 rounded-[22px] bg-card p-4 text-left ring-1 ring-border/60 transition active:scale-[0.99]">
          {asset ? (
            <>
              <div className="relative">
                <TokenAvatar symbol={asset.symbol} seed={asset.seed} logo={asset.logo} size={40} className="rounded-full" />
                <span className="absolute -right-0.5 -bottom-0.5">
                  <ChainGlyph chain={TON_CHAIN} size={16} />
                </span>
              </div>
              <div className="flex-1">
                <div className="text-[15px] font-semibold">{asset.symbol}</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-foreground">余额 {fmt(asset.amount)}</div>
              </div>
            </>
          ) : (
            <div className="h-10 flex-1 animate-pulse rounded-xl bg-muted" />
          )}
          <CaretDown size={16} weight="bold" className="text-muted-foreground" />
        </button>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">收款地址</span>
            <span className="flex items-center gap-1.5">
              <button type="button" onClick={() => setSheet("book")} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                <AddressBook size={14} />
                地址簿
              </button>
              {canScan && (
                <button type="button" onClick={scan} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                  <Scan size={14} />
                  扫一扫
                </button>
              )}
              <button type="button" onClick={paste} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                <ClipboardText size={14} />
                粘贴
              </button>
            </span>
          </div>
          <textarea
            value={to}
            onChange={(e) => setTo(e.target.value)}
            rows={2}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="TON 地址（UQ / EQ 开头）"
            className="mt-1 min-h-[48px] w-full resize-none bg-transparent font-mono text-[15px] leading-6 break-all outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
          />
          {to.trim() && !toAddr && <div className="text-[12px] text-down">{to.trim().startsWith("0x") ? "这是 EVM 地址，TON 上不能用" : "地址格式不对（TON 地址 48 位，UQ / EQ 开头）"}</div>}
          {selfSend && <div className="text-[12px] text-[#d48806]">这是你自己的地址</div>}
          {contact ? (
            <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
              <AddressBook size={14} weight="fill" />
              <span className="truncate">地址簿：{contact.name}</span>
            </div>
          ) : (
            toAddr &&
            book.recent.some((r) => sameTonAddress(r, toAddr)) && (
              <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
                <ShieldCheck size={14} weight="fill" />
                以前转过这个地址
              </div>
            )
          )}
          {book.recent.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {book.recent.map((r) => {
                const name = book.contacts.find((c) => sameTonAddress(c.address, r))?.name;
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
            <span>数量</span>
            {asset?.priceUsd != null && value != null && <span className="font-mono">≈ ${(Number(amount) * asset.priceUsd).toFixed(2)}</span>}
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <input
              value={amount}
              onChange={(e) => {
                setAll(false);
                setAmount(e.target.value.replace(/[^0-9.]/g, ""));
              }}
              inputMode="decimal"
              placeholder="0"
              className={cn("w-0 flex-1 bg-transparent font-mono text-[36px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40", blocker && value && "text-down")}
            />
            <span className="text-[17px] font-semibold text-muted-foreground">{asset?.symbol}</span>
          </div>
          {blocker && value != null && value > 0n && <div className="text-[12px] text-down">{blocker}</div>}
          {sendAll && !blocker && <div className="text-[12px] text-muted-foreground">转出全部余额，网络费从里面扣，钱包会清零</div>}
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[0.25, 0.5, 0.75, 1].map((p) => (
              <button key={p} type="button" onClick={() => setMax(p)} className="h-9 rounded-xl bg-muted text-[13px] font-medium transition active:scale-95">
                {p === 1 ? "最大" : `${p * 100}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">备注 / Memo（选填）</span>
            <span className={cn("font-mono text-[11px]", memoBad ? "text-down" : "text-muted-foreground")}>
              {memoBytes}/{MEMO_MAX}
            </span>
          </div>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="给交易所充值时，按交易所给的填" autoCapitalize="none" spellCheck={false} className="mt-1 h-10 w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/70" />
          <p className="text-[12px] leading-5 text-muted-foreground">备注会公开写在链上。交易所要求填 Memo / Tag 的，漏填可能到不了账。</p>
        </div>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
              网络费
              <Info size={14} />
            </span>
            {fees.data ? <span className="font-mono text-[14px] font-semibold">{feeText}</span> : fees.isError ? <span className="text-[12px] text-down">估算失败</span> : <span className="h-3 w-16 animate-pulse rounded-full bg-border" />}
          </div>
          <p className="mt-3 text-[12px] leading-5 text-muted-foreground">
            TON 的网络费用 GRAM 付{fees.data?.deploy ? "；这是这个钱包的第一笔转账，会顺带激活钱包合约（W5），所以稍贵一点" : ""}。
            {asset?.jetton ? `转 ${asset.symbol} 要附带 0.05 GRAM 给代币合约付手续费，实际一般只用 0.01～0.03，剩下的会退回。` : ""}
          </p>
          {fees.data && !asset?.jetton && fees.data.destState !== "active" && toAddr && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-5 text-[#d48806]">
              <Warning size={14} className="mt-0.5 shrink-0" />
              对方地址还没激活过（没用过的新钱包），钱照样能到账，按「不退回」方式发送。
            </p>
          )}
        </div>
      </div>

      <div aria-hidden className="h-[calc(72px+max(16px,env(safe-area-inset-bottom)))] shrink-0 sm:hidden" />
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[430px] bg-background/90 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:sticky">
        <PrimaryButton disabled={!toAddr || !value || !!blocker || fee == null} onClick={() => setSheet("confirm")}>
          下一步
        </PrimaryButton>
      </div>

      <BottomSheet open={sheet === "asset"} onClose={() => setSheet(null)}>
        <div className="mb-3 text-center text-[17px] font-semibold">选择币种</div>
        <ul className="space-y-1">
          {assets.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  setAssetId(a.id);
                  setAmount("");
                  setAll(false);
                  setSheet(null);
                }}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-3", a.id === asset?.id ? "bg-muted" : "hover:bg-muted/60")}
              >
                <TokenAvatar symbol={a.symbol} seed={a.seed} logo={a.logo} size={36} className="rounded-full" />
                <span className="flex-1 text-left">
                  <span className="block text-[15px] font-semibold">{a.symbol}</span>
                  {a.jetton && <span className="block font-mono text-[11px] text-muted-foreground">{shortAddr(a.jetton, 4, 4)}</span>}
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
          <Result sent={sent} explorer={sent.status === "success" ? explorerTx(TON_CHAIN, sent.hash) : explorerAddr(TON_CHAIN, from)} to={toAddr} saved={!!contact} />
        ) : (
          <TonConfirm asset={asset} amount={sendAll ? `全部（约 ${amount}）` : amount} fromName={active?.name} from={from} to={toAddr} toName={contact?.name} memo={memo} fee={asset?.jetton ? `${feeText} + 附带 0.05（多的退回）` : feeText} onCancel={() => setSheet(null)} onSend={send} />
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

function TonConfirm({ asset, amount, fromName, from, to, toName, memo, fee, onCancel, onSend }: { asset?: Asset; amount: string; fromName?: string; from: string; to?: string; toName?: string; memo: string; fee: string; onCancel: () => void; onSend: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="text-center text-[17px] font-semibold">确认转账</div>
      <div className="mt-5 text-center">
        <div className="font-mono text-[34px] font-semibold tracking-tight">
          {amount} <span className="text-[18px] text-muted-foreground">{asset?.symbol}</span>
        </div>
        {asset?.priceUsd != null && Number(amount) > 0 && <div className="mt-1 font-mono text-[13px] text-muted-foreground">≈ ${(Number(amount) * asset.priceUsd).toFixed(2)}</div>}
      </div>
      <dl className="mt-5 divide-y divide-border/60 rounded-[20px] bg-muted/60 px-4 text-[14px]">
        <Row label="从">
          <span className="flex items-center gap-1.5">
            <WalletDot address={from} size={16} />
            {fromName}
            <span className="font-mono text-muted-foreground">{shortAddr(from, 4, 4)}</span>
          </span>
        </Row>
        <Row label="到">
          <span className="flex max-w-[230px] flex-col items-end text-right">
            {toName && <span className="text-[14px] font-medium">{toName}</span>}
            <span className="font-mono text-[13px] break-all">{to}</span>
          </span>
        </Row>
        <Row label="网络">
          <span className="flex items-center gap-1.5">
            <ChainGlyph chain={TON_CHAIN} size={16} />
            TON
          </span>
        </Row>
        {asset?.jetton && (
          <Row label="代币合约">
            <span className="font-mono text-[13px]">{shortAddr(asset.jetton, 6, 6)}</span>
          </Row>
        )}
        {memo && (
          <Row label="备注">
            <span className="max-w-[230px] text-right text-[13px] break-all">{memo}</span>
          </Row>
        )}
        <Row label="网络费">
          <span className="text-right font-mono text-[13px]">{fee}</span>
        </Row>
      </dl>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-muted-foreground">
        <Warning size={14} className="mt-0.5 shrink-0" />
        链上转账发出后无法撤回，请确认对方给的是 TON 地址（交易所充值记得填 Memo）。
      </p>
      <div className="mt-4 grid grid-cols-[1fr_2fr] gap-2">
        <GhostButton onClick={onCancel}>取消</GhostButton>
        <PrimaryButton
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSend();
            setBusy(false);
          }}
        >
          {busy ? "签名发送中…" : "确认并转账"}
        </PrimaryButton>
      </div>
    </>
  );
}
