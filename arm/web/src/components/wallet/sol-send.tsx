"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
import { AddressBook, CaretDown, ClipboardText, Info, Lightning, Scan, ShieldCheck, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SOL_CHAIN, explorerTx, rpcOf, useNodes } from "@/lib/wallet/chains";
import { hasFeature, reportResult, returnsToApp, scanQr } from "@/lib/wallet/native";
import { transferMessage } from "@/lib/wallet/payee";
import { parseScannedSol } from "@/lib/wallet/scan";
import { isSolEntry, pushRecent, useAddressBook } from "@/lib/wallet/address-book";
import { useAssets, type Asset } from "@/lib/wallet/assets";
import {
  LAMPORTS,
  RENT_EXEMPT_MIN,
  SIGNATURE_FEE,
  TOKEN_ACCOUNT_RENT,
  accountExists,
  ataOf,
  b64,
  compileMessage,
  explainSolError,
  isSolAddress,
  isWalletAddress,
  ix,
  latestBlockhash,
  priorityFees,
  sendAndConfirm,
  signBytes,
  signMessageTx,
  simulate,
  unsignedTx,
  type Instruction,
} from "@/lib/wallet/sol";
import { useVault } from "@/components/wallet/wallet-context";
import { BookPicker, Result, Row, useScanSwitch, useSendLink, type Sent } from "@/components/wallet/send-parts";
import { BottomSheet, ChainGlyph, ChainPill, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const SPEEDS = [
  { key: "low", label: "慢" },
  { key: "mid", label: "推荐" },
  { key: "high", label: "快" },
] as const;
type Speed = (typeof SPEEDS)[number]["key"];

const noSubscribe = () => () => {};
const fmt = (n: number, max = 6) => n.toLocaleString("en-US", { maximumFractionDigits: max });
/** Fees differ by a few hundred lamports, so show down to the lamport. */
const sol = (lamports: bigint | number) => fmt(Number(lamports) / LAMPORTS, 9);

/** Instructions for moving `value` of `asset` to `to`; SPL transfers open the recipient's token account when it is missing. */
function transferIxs(from: string, to: string, asset: Asset, value: bigint, destHasAta: boolean): Instruction[] {
  if (!asset.mint) return [ix.transfer(from, to, value)];
  const program = asset.program!;
  const out: Instruction[] = [];
  if (!destHasAta) out.push(ix.createAtaIdempotent(from, to, asset.mint, program));
  out.push(ix.transferChecked(asset.solAccount!, asset.mint, ataOf(to, asset.mint, program), from, value, asset.decimals, program));
  return out;
}

export function SolSend() {
  useNodes();
  const { active, solKeypair, address: from } = useVault();
  const url = rpcOf(SOL_CHAIN);
  const { assets, loading } = useAssets(SOL_CHAIN, from);
  const link = useSendLink(SOL_CHAIN, assets, loading);
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === (assetId ?? link.wantedId)) ?? assets.find((a) => a.gas) ?? assets[0];
  const solAsset = assets.find((a) => a.id === "native");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  useEffect(() => {
    if (!link.amount) return;
    const t = setTimeout(() => setAmount((cur) => cur || link.amount!), 0);
    return () => clearTimeout(t);
  }, [link.amount]);
  const [speed, setSpeed] = useState<Speed>("mid");
  const [sheet, setSheet] = useState<null | "asset" | "confirm" | "book">(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [scanned, setScanned] = useState<{ mint?: string; amount?: string } | null>(null);
  const full = useAddressBook();
  const book = { contacts: full.contacts.filter((c) => isSolEntry(c.address)), recent: full.recent.filter(isSolEntry) };
  const canScan = useSyncExternalStore(noSubscribe, () => hasFeature("scan"), () => false);
  const switchToScanned = useScanSwitch();

  const wantedTo = link.to;
  useEffect(() => {
    if (!wantedTo || !isSolAddress(wantedTo)) return;
    const t = setTimeout(() => setTo((cur) => cur || wantedTo), 0);
    return () => clearTimeout(t);
  }, [wantedTo]);

  useEffect(() => {
    if (!scanned || loading || assets.length === 0) return;
    const a = scanned.mint ? assets.find((x) => x.mint === scanned.mint) : assets.find((x) => x.id === "native");
    const t = setTimeout(() => {
      setScanned(null);
      if (!a) return void toast.warning("二维码里的代币你还没有持有，请自己选择币种");
      setAssetId(a.id);
      if (scanned.amount) setAmount(scanned.amount);
    }, 0);
    return () => clearTimeout(t);
  }, [scanned, loading, assets]);

  const toAddr = isSolAddress(to) ? to.trim() : undefined;
  const offCurve = !!toAddr && !isWalletAddress(toAddr);
  const contact = toAddr ? book.contacts.find((c) => c.address === toAddr) : undefined;
  const selfSend = !!toAddr && toAddr === from;
  let value: bigint | null = null;
  try {
    value = asset && amount ? parseUnits(amount, asset.decimals) : null;
  } catch {
    value = null;
  }

  // recipient state decides rent: a new SOL account needs ≥ rent-exempt minimum, a new token account costs the sender rent
  const dest = useQuery({
    queryKey: ["wallet", "sol-dest", url, toAddr, asset?.mint],
    enabled: !!toAddr && !!asset,
    queryFn: async () => ({ exists: await accountExists(url, toAddr!), ata: asset!.mint ? await accountExists(url, ataOf(toAddr!, asset!.mint, asset!.program)) : true }),
    staleTime: 15_000,
  });

  // fee: simulate the real instructions (self-transfer until an address is typed) for compute units; priority fee percentiles
  const simTo = toAddr ?? from;
  const fees = useQuery({
    // amount isn't in the key: compute units don't depend on it, and a fee that moves after "最大" would leave dust
    queryKey: ["wallet", "sol-fees", url, from, simTo, asset?.id, dest.data?.ata],
    enabled: !!from && !!asset && !!simTo,
    queryFn: async () => {
      const v = asset!.mint ? 1n : BigInt(RENT_EXEMPT_MIN);
      const body = transferIxs(from!, simTo!, asset!, v, dest.data?.ata ?? true);
      const { blockhash } = await latestBlockhash(url);
      const [sim, prio] = await Promise.all([
        simulate(url, unsignedTx(compileMessage(from!, [ix.computeLimit(200_000), ix.computePrice(1n), ...body], blockhash))).catch(() => null),
        priorityFees(url, [from!, ...body.flatMap((i) => i.keys.filter((k) => k.writable).map((k) => k.pubkey))]).catch(() => ({ low: 1_000n, mid: 10_000n, high: 100_000n })),
      ]);
      const units = Math.max(1_000, Math.ceil((sim?.units || (asset!.mint ? 40_000 : 600)) * 1.3) + 300);
      return { units, prio, simError: sim?.err ? explainSolError(sim.err, sim.logs) : null };
    },
    refetchInterval: 20_000,
  });
  const feeOf = (s: Speed) => (fees.data ? BigInt(SIGNATURE_FEE) + (fees.data.prio[s] * BigInt(fees.data.units) + 999_999n) / 1_000_000n : null);
  const fee = feeOf(speed);
  const rent = asset?.mint && toAddr && dest.data && !dest.data.ata ? BigInt(TOKEN_ACCOUNT_RENT) : 0n;
  const solCost = (fee ?? 0n) + rent + (asset && !asset.mint ? (value ?? 0n) : 0n);
  const solBal = solAsset?.raw ?? 0n;
  const over = !!asset && value != null && (asset.mint ? value > asset.raw : false);
  const solShort = !!asset && fee != null && solCost > solBal;
  const leftover = solBal - solCost;
  const dust = !!asset && !asset.mint && value != null && value > 0n && leftover > 0n && leftover < BigInt(RENT_EXEMPT_MIN);
  const tooSmallForNew = !!asset && !asset.mint && !!toAddr && dest.data?.exists === false && value != null && value > 0n && value < BigInt(RENT_EXEMPT_MIN);
  const split = !!asset?.mint && !over && value != null && asset.solAccountRaw != null && value > asset.solAccountRaw;
  const blocker = over ? "余额不足" : split ? `这个币分散在几个代币账户里，一次最多转 ${fmt(Number(formatUnits(asset!.solAccountRaw!, asset!.decimals)))}` : solShort ? `SOL 不够（需要 ${sol(solCost)} SOL，含网络费${rent ? "和开户租金" : ""}）` : dust ? `转完只剩 ${sol(leftover)} SOL，Solana 账户要么转空、要么至少留 0.00089 SOL` : tooSmallForNew ? "对方是新地址，第一笔至少要转 0.00089 SOL" : null;

  const setMax = (p: number) => {
    if (!asset) return;
    if (asset.mint) return setAmount(formatUnits((asset.raw * BigInt(Math.round(p * 100))) / 100n, asset.decimals));
    // SOL: "最大" empties the account (fee included); partial amounts keep at least the rent-exempt minimum
    if (fee == null) return void toast.info("网络费还在估算，稍等一下");
    const room = p === 1 ? solBal - fee : ((solBal - fee - BigInt(RENT_EXEMPT_MIN)) * BigInt(Math.round(p * 100))) / 100n;
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
    const p = parseScannedSol(text);
    if (!p) return void (switchToScanned(text) || toast.error("没认出 Solana 收款地址，请换一个二维码或手动粘贴"));
    setTo(p.to);
    if (p.mint || p.amount) setScanned({ mint: p.mint, amount: p.amount });
  };
  const paste = async () => {
    try {
      setTo((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error("无法读取剪贴板，请手动粘贴");
    }
  };

  const send = async () => {
    if (!asset || !toAddr || value == null || !fees.data || fee == null || !from) return;
    let signature: string | null = null;
    try {
      const kp = solKeypair();
      const { blockhash, lastValidBlockHeight } = await latestBlockhash(url);
      const ata = asset.mint ? await accountExists(url, ataOf(toAddr, asset.mint, asset.program)) : true;
      const msg = compileMessage(from, [ix.computeLimit(fees.data.units), ix.computePrice(fees.data.prio[speed]), ...transferIxs(from, toAddr, asset, value, ata)], blockhash);
      const signed = signMessageTx(msg, kp);
      signature = signed.signature;
      setSent({ hash: signature, status: "pending" });
      await sendAndConfirm(url, signed.tx, signature, lastValidBlockHeight);
      pushRecent(toAddr);
      setSent({ hash: signature, status: "success" });
      if (returnsToApp()) {
        const proof = b64.encode(signBytes(new TextEncoder().encode(transferMessage(signature, from, toAddr)), kp));
        reportResult({ kind: "transfer", chain: SOL_CHAIN.key, token: asset.mint ?? "native", symbol: asset.symbol, decimals: asset.decimals, amount: value.toString(), to: toAddr, from, hash: signature, proof, req: link.req });
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (signature) setSent({ hash: signature, status: "error", error: msg });
      else toast.error(msg);
    }
  };

  if (!from) {
    return (
      <WalletFrame>
        <TopBar title="转账" back="/wallet" right={<ChainPill chain={SOL_CHAIN} />} />
        <p className="px-6 py-16 text-center text-[14px] leading-7 text-muted-foreground">
          「{active?.name}」是用私钥导入的，没有 Solana 账户。
          <br />
          请切换到助记词钱包。
        </p>
      </WalletFrame>
    );
  }

  return (
    <WalletFrame>
      <TopBar title={link.name ? `转账给 ${link.name}` : "转账"} back="/wallet" right={<ChainPill chain={SOL_CHAIN} />} />

      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        {link.notHeld && <p className="rounded-2xl bg-[#d48806]/10 px-3.5 py-2.5 text-[12px] leading-5 text-[#b07005]">你还没有持有对方要的那个币，先买一点或换个币转。</p>}
        <button type="button" onClick={() => setSheet("asset")} disabled={loading} className="flex items-center gap-3 rounded-[22px] bg-card p-4 text-left ring-1 ring-border/60 transition active:scale-[0.99]">
          {asset ? (
            <>
              <div className="relative">
                <TokenAvatar symbol={asset.symbol} seed={asset.seed} logo={asset.logo} size={40} className="rounded-full" />
                <span className="absolute -right-0.5 -bottom-0.5">
                  <ChainGlyph chain={SOL_CHAIN} size={16} />
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
            placeholder="Solana 地址"
            className="mt-1 min-h-[48px] w-full resize-none bg-transparent font-mono text-[15px] leading-6 break-all outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
          />
          {to.trim() && !toAddr && <div className="text-[12px] text-down">{to.trim().startsWith("0x") ? "这是 EVM 地址，Solana 上不能用" : "地址格式不对"}</div>}
          {selfSend && <div className="text-[12px] text-[#d48806]">这是你自己的地址</div>}
          {offCurve && <div className="text-[12px] text-[#d48806]">这是程序地址（PDA），不是普通钱包；转进去通常取不出来</div>}
          {contact ? (
            <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
              <AddressBook size={14} weight="fill" />
              <span className="truncate">地址簿：{contact.name}</span>
            </div>
          ) : (
            toAddr &&
            book.recent.includes(toAddr) && (
              <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
                <ShieldCheck size={14} weight="fill" />
                以前转过这个地址
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
            <span>数量</span>
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
                {p === 1 ? "最大" : `${p * 100}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
              网络费
              <Info size={14} />
            </span>
            <span className="text-[12px] text-muted-foreground">用 SOL 支付</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1">
            {SPEEDS.map((s) => {
              const f = feeOf(s.key);
              const on = speed === s.key;
              return (
                <button key={s.key} type="button" onClick={() => setSpeed(s.key)} className={cn("flex min-w-0 flex-col items-center rounded-xl px-1 py-2 transition", on ? "bg-card shadow-sm" : "text-muted-foreground")}>
                  <span className={cn("flex items-center gap-0.5 text-[13px]", on ? "font-semibold" : "font-medium")}>
                    {s.key === "high" && <Lightning size={12} weight="fill" className={on ? "text-amber-500" : undefined} />}
                    {s.label}
                  </span>
                  {f != null ? <span className="mt-0.5 max-w-full truncate font-mono text-[11px]">{sol(f)}</span> : <span className="mt-1.5 mb-0.5 h-2.5 w-10 animate-pulse rounded-full bg-border" />}
                </button>
              );
            })}
          </div>
          {rent > 0n && (
            <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-muted-foreground">
              <Info size={14} className="mt-0.5 shrink-0" />
              对方还没有 {asset?.symbol} 账户，这笔会顺带帮他开户，多付 {sol(rent)} SOL 租金（Solana 规则，钱进了对方的代币账户）。
            </p>
          )}
          {fees.data?.simError && toAddr && value != null && value > 0n && !blocker && (
            <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-[#d48806]">
              <Warning size={14} className="mt-0.5 shrink-0" />
              预演失败：{fees.data.simError}
            </p>
          )}
          {asset?.mint && <p className="mt-3 text-[12px] text-muted-foreground">需要钱包里有少量 SOL 付网络费。</p>}
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
                  setSheet(null);
                }}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-3", a.id === asset?.id ? "bg-muted" : "hover:bg-muted/60")}
              >
                <TokenAvatar symbol={a.symbol} seed={a.seed} logo={a.logo} size={36} className="rounded-full" />
                <span className="flex-1 text-left">
                  <span className="block text-[15px] font-semibold">{a.symbol}</span>
                  {a.mint && <span className="block font-mono text-[11px] text-muted-foreground">{shortAddr(a.mint, 4, 4)}</span>}
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
          <Result sent={sent} explorer={explorerTx(SOL_CHAIN, sent.hash)} to={toAddr} saved={!!contact} />
        ) : (
          <SolConfirm asset={asset} amount={amount} fromName={active?.name} from={from} to={toAddr} toName={contact?.name} fee={fee != null ? `${sol(fee + rent)} SOL` : "—"} rent={rent} onCancel={() => setSheet(null)} onSend={send} />
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

function SolConfirm({ asset, amount, fromName, from, to, toName, fee, rent, onCancel, onSend }: { asset?: Asset; amount: string; fromName?: string; from: string; to?: string; toName?: string; fee: string; rent: bigint; onCancel: () => void; onSend: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="text-center text-[17px] font-semibold">确认转账</div>
      <div className="mt-5 text-center">
        <div className="font-mono text-[34px] font-semibold tracking-tight">
          {amount} <span className="text-[18px] text-muted-foreground">{asset?.symbol}</span>
        </div>
        {asset?.priceUsd != null && <div className="mt-1 font-mono text-[13px] text-muted-foreground">≈ ${(Number(amount) * asset.priceUsd).toFixed(2)}</div>}
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
            <ChainGlyph chain={SOL_CHAIN} size={16} />
            Solana
          </span>
        </Row>
        {asset?.mint && (
          <Row label="代币合约">
            <span className="font-mono text-[13px]">{shortAddr(asset.mint, 6, 6)}</span>
          </Row>
        )}
        <Row label={rent > 0n ? "网络费 + 开户租金" : "网络费"}>
          <span className="font-mono">{fee}</span>
        </Row>
      </dl>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-muted-foreground">
        <Warning size={14} className="mt-0.5 shrink-0" />
        链上转账发出后无法撤回，请确认地址是 Solana 地址。
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
