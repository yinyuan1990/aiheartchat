"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { createWalletClient, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, isAddress, parseUnits, type Address, type Hex } from "viem";
import { AddressBook, CaretDown, ClipboardText, Info, Lightning, Scan, ShieldCheck, SlidersHorizontal, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar, WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SOL_CHAIN, chainById, explorerTx, isSolana, publicClientFor, rpcOf } from "@/lib/wallet/chains";
import { hasFeature, scanQr } from "@/lib/wallet/native";
import { parseScanned } from "@/lib/wallet/scan";
import { isSolEntry, pushRecent, useAddressBook } from "@/lib/wallet/address-book";
import { useAssets, type Asset } from "@/lib/wallet/assets";
import { isSolAddress } from "@/lib/wallet/sol";
import { useVault } from "@/components/wallet/wallet-context";
import { BookPicker, Result, Row, type Sent } from "@/components/wallet/send-parts";
import { SolSend } from "@/components/wallet/sol-send";
import { BottomSheet, ChainGlyph, ChainPill, GhostButton, PrimaryButton, TopBar, WalletFrame, useQueryParam } from "@/components/wallet/ui";

const SPEEDS = [
  { key: "slow", label: "慢", mul: 0.9 },
  { key: "normal", label: "推荐", mul: 1 },
  { key: "fast", label: "快", mul: 1.5 },
] as const;
type Speed = (typeof SPEEDS)[number]["key"] | "custom";
/** Gwei strings as typed in the advanced sheet. */
type CustomGas = { maxFee: string; tip: string; gas: string };
type Fee = { maxFee: bigint; tip: bigint; gas: bigint; cost: bigint };

const toGwei = (wei: bigint) => formatUnits(wei, 9).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
const gweiLabel = (wei: bigint) => {
  const g = Number(formatUnits(wei, 9));
  return g > 0 && g < 0.0001 ? "<0.0001" : g.toLocaleString("en-US", { maximumFractionDigits: 4 });
};
function parseCustom(c: CustomGas): Fee | null {
  try {
    const maxFee = parseUnits(c.maxFee || "0", 9);
    const tip = c.tip ? parseUnits(c.tip, 9) : 0n;
    const gas = BigInt(c.gas || "0");
    if (maxFee <= 0n || gas <= 0n || tip > maxFee) return null;
    return { maxFee, tip, gas, cost: gas * maxFee };
  } catch {
    return null;
  }
}

const noSubscribe = () => () => {};

const fmt = (n: number, max = 6) => n.toLocaleString("en-US", { maximumFractionDigits: max });

export default function SendPage() {
  const { chain, setChain } = useVault();
  const wantedTo = useQueryParam("to");
  // "转账" from an address-book entry: open the chain family the address belongs to
  useEffect(() => {
    if (!wantedTo) return;
    const want = isSolAddress(wantedTo) ? "sol" : isAddress(wantedTo) ? "evm" : null;
    if (!want || (want === "sol") === isSolana(chain)) return;
    const t = setTimeout(() => setChain(want === "sol" ? SOL_CHAIN.key : "arc"), 0);
    return () => clearTimeout(t);
  }, [wantedTo, chain, setChain]);
  return isSolana(chain) ? <SolSend /> : <EvmSend />;
}

function EvmSend() {
  const { active, chain, account, setChain } = useVault();
  const from = active?.address;
  const { assets, loading } = useAssets(chain, from);
  const wanted = useQueryParam("asset");
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === (assetId ?? wanted)) ?? assets.find((a) => a.raw > 0n) ?? assets[0];
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [speed, setSpeed] = useState<Speed>("normal");
  const [custom, setCustom] = useState<CustomGas | null>(null);
  const [sheet, setSheet] = useState<null | "asset" | "confirm" | "book" | "gas">(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const fullBook = useAddressBook();
  const book = { contacts: fullBook.contacts.filter((c) => !isSolEntry(c.address)), recent: fullBook.recent.filter((a) => !isSolEntry(a)) };
  const recent = book.recent;
  const canScan = useSyncExternalStore(noSubscribe, () => hasFeature("scan"), () => false);
  // coin / amount from a scanned EIP-681 link, applied once that chain's asset list is in
  const [scanned, setScanned] = useState<{ chainId: number; token?: string; raw?: bigint } | null>(null);

  const nc = chain.chain.nativeCurrency;

  const wantedTo = useQueryParam("to");
  useEffect(() => {
    if (!wantedTo || !isAddress(wantedTo)) return;
    const t = setTimeout(() => setTo((cur) => cur || getAddress(wantedTo)), 0);
    return () => clearTimeout(t);
  }, [wantedTo]);

  useEffect(() => {
    if (!scanned || scanned.chainId !== chain.chain.id || loading || assets.length === 0) return;
    const a = scanned.token ? assets.find((x) => x.token?.toLowerCase() === scanned.token) : assets.find((x) => x.id === (chain.nativeIsUsdc ? "usdc" : "native"));
    const t = setTimeout(() => {
      setScanned(null);
      if (!a) return void toast.warning("二维码里的代币不在当前钱包的币种列表里，请自己选择币种");
      setAssetId(a.id);
      if (scanned.raw != null) setAmount(formatUnits(scanned.raw, scanned.token ? a.decimals : chain.chain.nativeCurrency.decimals));
    }, 0);
    return () => clearTimeout(t);
  }, [scanned, chain, loading, assets]);

  const scan = async () => {
    let text: string | null;
    try {
      text = await scanQr();
    } catch (e) {
      return void toast.error((e as Error).message);
    }
    if (!text) return;
    const p = parseScanned(text);
    if (!p) return void toast.error("没认出收款地址，请换一个二维码或手动粘贴");
    let target = chain;
    if (p.chainId && p.chainId !== chain.chain.id) {
      const c = chainById(p.chainId);
      if (!c) return void toast.error(`二维码指定的链（ID ${p.chainId}）钱包暂不支持`);
      setChain(c.key);
      target = c;
      toast.info(`二维码指定 ${c.name} 网络，已切换`);
    }
    setTo(p.to);
    if (p.token || p.raw != null) setScanned({ chainId: target.chain.id, token: p.token?.toLowerCase(), raw: p.raw });
  };
  const validTo = isAddress(to.trim());
  const toAddr = validTo ? getAddress(to.trim()) : undefined;
  const contact = toAddr ? book.contacts.find((c) => c.address === toAddr) : undefined;
  let value: bigint | null = null;
  try {
    value = asset && amount ? parseUnits(amount, asset.decimals) : null;
  } catch {
    value = null;
  }

  // Until an address is typed the fee is estimated as a transfer to yourself; sending still requires toAddr.
  const call = useMemo(() => {
    const dest = toAddr ?? from;
    if (!asset || !dest) return null;
    const v = value ?? 0n;
    return asset.token ? { to: asset.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, v] }), value: 0n } : { to: dest, data: undefined, value: v };
  }, [asset, toAddr, from, value]);

  const fees = useQuery({
    queryKey: ["wallet", "send-fees", chain.key, from, call?.to, call?.data, call?.value?.toString()],
    enabled: !!from && !!call,
    queryFn: async () => {
      const pc = publicClientFor(chain);
      const gas = await pc.estimateGas({ account: from!, to: call!.to, data: call!.data, value: call!.value }).catch(() => (asset?.token ? 90_000n : 21_000n));
      try {
        const f = await pc.estimateFeesPerGas();
        return { gas, maxFee: f.maxFeePerGas, tip: f.maxPriorityFeePerGas, legacy: false };
      } catch {
        return { gas, maxFee: await pc.getGasPrice(), tip: 0n, legacy: true };
      }
    },
    refetchInterval: 15_000,
  });

  const speedFee = (s: Speed): Fee | null => {
    if (s === "custom") return custom ? parseCustom(custom) : null;
    if (!fees.data) return null;
    const mul = BigInt(Math.round(SPEEDS.find((x) => x.key === s)!.mul * 100));
    const maxFee = (fees.data.maxFee * mul) / 100n;
    const tip = (fees.data.tip * mul) / 100n;
    return { maxFee, tip, gas: (fees.data.gas * 12n) / 10n, cost: (fees.data.gas * maxFee * 12n) / 10n };
  };
  const chosen = speedFee(speed);
  // On Arc the fee comes out of the same USDC balance being sent.
  const feeFromSameBalance = !!asset && (!asset.token || (chain.nativeIsUsdc && asset.gas));
  const feeInAsset = chosen && asset ? (feeFromSameBalance ? (asset.token ? chosen.cost / 10n ** BigInt(18 - asset.decimals) : chosen.cost) : 0n) : 0n;
  const over = !!asset && value != null && value + feeInAsset > asset.raw;
  const selfSend = toAddr && from && toAddr === from;

  const setMax = (p: number) => {
    if (!asset) return;
    const room = asset.raw - (feeFromSameBalance ? (feeInAsset * 3n) / 2n : 0n);
    const v = room > 0n ? (room * BigInt(Math.round(p * 100))) / 100n : 0n;
    setAmount(formatUnits(v, asset.decimals));
  };

  const send = async () => {
    if (!call || !chosen || value == null || !toAddr) return;
    let hash: Hex | null = null;
    try {
      const wc = createWalletClient({ account: account(), chain: chain.chain, transport: http(rpcOf(chain)) });
      const base = { to: call.to, data: call.data, value: call.value, gas: chosen.gas };
      hash = fees.data?.legacy
        ? await wc.sendTransaction({ ...base, gasPrice: chosen.maxFee })
        : await wc.sendTransaction({ ...base, maxFeePerGas: chosen.maxFee, maxPriorityFeePerGas: chosen.tip });
      pushRecent(toAddr);
      setSent({ hash, status: "pending" });
      const r = await publicClientFor(chain).waitForTransactionReceipt({ hash, timeout: 120_000 });
      setSent({ hash, status: r.status === "success" ? "success" : "reverted" });
    } catch (e) {
      const msg = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0];
      if (hash) setSent({ hash, status: "error", error: msg });
      else toast.error(msg);
    }
  };

  const paste = async () => {
    try {
      setTo((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error("无法读取剪贴板，请手动粘贴");
    }
  };

  /** `short` drops the symbol (the four-up picker; the card header already says which coin pays). */
  const fmtFee = (wei: bigint, short = false) => {
    const n = Number(formatUnits(wei, nc.decimals));
    const v = n < 0.0001 && n > 0 ? "<0.0001" : fmt(n, 4);
    return short ? v : `${v} ${nc.symbol}`;
  };

  return (
    <WalletFrame>
      <TopBar title="转账" back="/wallet" right={<ChainPill chain={chain} />} />

      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        <button type="button" onClick={() => setSheet("asset")} disabled={loading} className="flex items-center gap-3 rounded-[22px] bg-card p-4 text-left ring-1 ring-border/60 transition active:scale-[0.99]">
          {asset ? (
            <>
              <div className="relative">
                <TokenAvatar symbol={asset.symbol} seed={asset.seed} logo={asset.logo} size={40} className="rounded-full" />
                <span className="absolute -right-0.5 -bottom-0.5">
                  <ChainGlyph chain={chain} size={16} />
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
            placeholder={`${chain.name} 上的 0x 地址`}
            className="mt-1 min-h-[48px] w-full resize-none bg-transparent font-mono text-[15px] leading-6 break-all outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
          />
          {to.trim() && !validTo && <div className="text-[12px] text-down">地址格式不对</div>}
          {selfSend && <div className="text-[12px] text-[#d48806]">这是你自己的地址</div>}
          {contact ? (
            <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
              <AddressBook size={14} weight="fill" />
              <span className="truncate">地址簿：{contact.name}</span>
            </div>
          ) : (
            toAddr &&
            recent.includes(toAddr) && (
              <div className="mt-1 flex items-center gap-1.5 rounded-xl bg-up/10 px-2.5 py-1.5 text-[12px] text-up">
                <ShieldCheck size={14} weight="fill" />
                以前转过这个地址
              </div>
            )
          )}
          {recent.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {recent.map((r) => {
                const name = book.contacts.find((c) => c.address === r)?.name;
                return (
                  <button key={r} type="button" onClick={() => setTo(r)} className={cn("flex max-w-[160px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition active:scale-95", name ? "font-medium" : "font-mono", toAddr === r ? "border-foreground" : "border-border")}>
                    <WalletDot address={r} size={14} />
                    <span className="truncate">{name ?? shortAddr(r, 6, 4)}</span>
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
              className={cn("w-0 flex-1 bg-transparent font-mono text-[36px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40", over && "text-down")}
            />
            <span className="text-[17px] font-semibold text-muted-foreground">{asset?.symbol}</span>
          </div>
          {over && <div className="text-[12px] text-down">余额不足{feeFromSameBalance ? "（还要留出网络费）" : ""}</div>}
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
            <span className="text-[12px] text-muted-foreground">用 {nc.symbol} 支付</span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-2xl bg-muted p-1">
            {SPEEDS.map((s) => {
              const f = speedFee(s.key);
              const on = speed === s.key;
              return (
                <button key={s.key} type="button" onClick={() => setSpeed(s.key)} className={cn("flex min-w-0 flex-col items-center rounded-xl px-1 py-2 transition", on ? "bg-card shadow-sm" : "text-muted-foreground")}>
                  <span className={cn("flex items-center gap-0.5 text-[13px]", on ? "font-semibold" : "font-medium")}>
                    {s.key === "fast" && <Lightning size={12} weight="fill" className={on ? "text-amber-500" : undefined} />}
                    {s.label}
                  </span>
                  {f ? (
                    <span className="mt-0.5 max-w-full truncate font-mono text-[11px]">{fmtFee(f.cost, true)}</span>
                  ) : (
                    <span className="mt-1.5 mb-0.5 h-2.5 w-10 animate-pulse rounded-full bg-border" />
                  )}
                </button>
              );
            })}
            <button type="button" disabled={!fees.data} onClick={() => setSheet("gas")} className={cn("flex min-w-0 flex-col items-center rounded-xl px-1 py-2 transition", speed === "custom" ? "bg-card shadow-sm" : "text-muted-foreground")}>
              <span className={cn("flex items-center gap-0.5 text-[13px]", speed === "custom" ? "font-semibold" : "font-medium")}>
                <SlidersHorizontal size={12} />
                自定义
              </span>
              <span className="mt-0.5 max-w-full truncate font-mono text-[11px]">{speed === "custom" && chosen ? fmtFee(chosen.cost, true) : "设置"}</span>
            </button>
          </div>
          {speed === "custom" && chosen && (
            <button type="button" onClick={() => setSheet("gas")} className="mt-2 w-full rounded-xl bg-muted/60 px-3 py-2 text-left font-mono text-[11px] leading-5 text-muted-foreground">
              {fees.data?.legacy ? `Gas 价格 ${gweiLabel(chosen.maxFee)} Gwei` : `最高 ${gweiLabel(chosen.maxFee)} Gwei · 小费 ${gweiLabel(chosen.tip)} Gwei`} · Gas 上限 {chosen.gas.toString()}
              {fees.data && chosen.gas < fees.data.gas && <span className="mt-0.5 block font-sans text-[#d48806]">Gas 上限低于这笔转账的估算（{fees.data.gas.toString()}），很可能失败</span>}
            </button>
          )}
          {!asset?.gas && asset && (
            <p className="mt-3 text-[12px] text-muted-foreground">
              需要钱包里有少量 {nc.symbol} 付网络费。
            </p>
          )}
        </div>
      </div>

      <div aria-hidden className="h-[calc(72px+max(16px,env(safe-area-inset-bottom)))] shrink-0 sm:hidden" />
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[430px] bg-background/90 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:sticky">
        <PrimaryButton disabled={!validTo || !value || over || !chosen} onClick={() => setSheet("confirm")}>
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
                <span className="flex-1 text-left text-[15px] font-semibold">{a.symbol}</span>
                <span className="font-mono text-[14px]">{fmt(a.amount, 4)}</span>
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      <BottomSheet open={sheet === "gas"} onClose={() => setSheet(null)}>
        {sheet === "gas" && fees.data && (
          <GasSheet
            legacy={fees.data.legacy}
            estimate={fees.data.gas}
            network={fees.data.maxFee}
            initial={custom ?? { maxFee: toGwei(speedFee("normal")!.maxFee), tip: toGwei(speedFee("normal")!.tip), gas: speedFee("normal")!.gas.toString() }}
            fmtFee={fmtFee}
            onSave={(c) => {
              setCustom(c);
              setSpeed("custom");
              setSheet(null);
            }}
          />
        )}
      </BottomSheet>

      <BottomSheet open={sheet === "book"} onClose={() => setSheet(null)}>
        {sheet === "book" && (
          <BookPicker
            contacts={book.contacts}
            recent={recent}
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
          <Result sent={sent} explorer={explorerTx(chain, sent.hash)} to={toAddr} saved={!!contact} />
        ) : (
          <ConfirmBody asset={asset} amount={amount} fromName={active?.name} from={from} to={toAddr} toName={contact?.name} chain={chain} fee={chosen ? fmtFee(chosen.cost) : "—"} onCancel={() => setSheet(null)} onSend={send} />
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

function ConfirmBody({ asset, amount, fromName, from, to, toName, chain, fee, onCancel, onSend }: { asset?: Asset; amount: string; fromName?: string; from?: Address; to?: Address; toName?: string; chain: ReturnType<typeof useVault>["chain"]; fee: string; onCancel: () => void; onSend: () => Promise<void> }) {
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
            {from && <WalletDot address={from} size={16} />}
            {fromName}
            <span className="font-mono text-muted-foreground">{from && shortAddr(from, 4, 4)}</span>
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
            <ChainGlyph chain={chain} size={16} />
            {chain.name}
          </span>
        </Row>
        <Row label="网络费（最多）">
          <span className="font-mono">{fee}</span>
        </Row>
      </dl>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-muted-foreground">
        <Warning size={14} className="mt-0.5 shrink-0" />
        链上转账发出后无法撤回，请确认地址和网络都正确。
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

function GasSheet({ legacy, estimate, network, initial, fmtFee, onSave }: { legacy: boolean; estimate: bigint; network: bigint; initial: CustomGas; fmtFee: (wei: bigint) => string; onSave: (c: CustomGas) => void }) {
  const [c, setC] = useState<CustomGas>(initial);
  const f = parseCustom(legacy ? { ...c, tip: "" } : c);
  const num = (k: keyof CustomGas, int = false) => (e: React.ChangeEvent<HTMLInputElement>) => setC((p) => ({ ...p, [k]: e.target.value.replace(int ? /[^0-9]/g : /[^0-9.]/g, "") }));
  let tipOver = false;
  try {
    tipOver = !legacy && !!c.tip && !!c.maxFee && parseUnits(c.tip, 9) > parseUnits(c.maxFee, 9);
  } catch {}
  const warnings: string[] = [];
  if (f && f.gas < estimate) warnings.push(`Gas 上限低于估算（${estimate.toString()}），交易很可能失败，网络费照扣`);
  if (f && f.maxFee < network / 2n) warnings.push("费用比推荐值低很多，可能很久都不确认");
  if (f && f.maxFee > network * 5n) warnings.push("费用比推荐值高很多，会多付网络费");

  const field = (label: string, k: keyof CustomGas, unit: string, hint: string, int = false) => (
    <div className="rounded-[18px] bg-muted/60 px-4 py-3">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span className="font-medium">{label}</span>
        <span>{hint}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <input value={c[k]} onChange={num(k, int)} inputMode={int ? "numeric" : "decimal"} className="w-0 flex-1 bg-transparent font-mono text-[20px] font-semibold outline-none" />
        <span className="text-[13px] text-muted-foreground">{unit}</span>
      </div>
    </div>
  );

  return (
    <>
      <div className="mb-4 text-center text-[17px] font-semibold">自定义网络费</div>
      <div className="space-y-2">
        {legacy ? (
          field("Gas 价格", "maxFee", "Gwei", `推荐 ${gweiLabel(network)}`)
        ) : (
          <>
            {field("最高费用", "maxFee", "Gwei", `推荐 ${gweiLabel(network)}`)}
            {field("优先小费", "tip", "Gwei", "给出块者，越高越快")}
          </>
        )}
        {field("Gas 上限", "gas", "", `估算 ${estimate.toString()}`, true)}
      </div>
      {tipOver && <p className="mt-2 text-[12px] text-down">小费不能高于最高费用</p>}
      {warnings.map((w) => (
        <p key={w} className="mt-2 flex items-start gap-1.5 text-[12px] leading-5 text-[#d48806]">
          <Warning size={14} className="mt-0.5 shrink-0" />
          {w}
        </p>
      ))}
      <div className="mt-4 flex items-center justify-between rounded-[18px] bg-muted/60 px-4 py-3 text-[14px]">
        <span className="text-muted-foreground">最多花费</span>
        <span className="font-mono font-semibold">{f ? fmtFee(f.cost) : "—"}</span>
      </div>
      <PrimaryButton className="mt-4" disabled={!f} onClick={() => onSave(legacy ? { ...c, tip: "" } : c)}>
        使用这个设置
      </PrimaryButton>
    </>
  );
}
