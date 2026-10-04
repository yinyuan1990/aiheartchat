"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createWalletClient, erc20Abi, formatUnits, http, parseUnits, type LocalAccount } from "viem";
import { CheckCircle, CircleNotch, Eye, EyeSlash, MagnifyingGlass, Robot, ShieldWarning, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { chainByKey, explorerTx, publicClientFor, rpcOf } from "@/lib/wallet/chains";
import { ARB_USDC, HL_BRIDGE, MIN_DEPOSIT, WITHDRAW_FEE, withdraw, type HlAsset } from "@/lib/wallet/hl";
import { AI_PROVIDERS, DEFAULT_RISK, providerOf, testAi, type AiConfig, type AiResult } from "@/lib/wallet/ai-trade";
import { GhostButton, PrimaryButton } from "./ui";

/** Inline gradient: Tailwind 4 gradient utilities don't render in Chromium 99. */
export const AI_GRADIENT = "linear-gradient(90deg, #7c3aed, #2563eb)";
export const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
/** "+$1.20" / "-$0.19" */
export const sUsd = (n: number, d = 2) => `${n >= 0 ? "+" : "-"}${usd(Math.abs(n), d)}`;
export const px = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4));

export function RiskGate({ onAccept }: { onAccept: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <>
      <div className="flex items-center justify-center gap-1.5 text-[17px] font-semibold text-down">
        <ShieldWarning size={20} weight="fill" />
        合约交易风险很高
      </div>
      <ul className="mt-4 space-y-2 text-[13px] leading-6 text-muted-foreground">
        <li>· 合约带杠杆，行情反向波动时可能在几分钟内亏光保证金（强平）。</li>
        <li>· 交易在 Hyperliquid（链上永续合约交易所）进行，资金存在你自己的 Hyperliquid 账户里，心之音和 Arm 不保管、不能动你的钱。</li>
        <li>· AI 只给建议，可能出错；每一笔都要你自己确认才会下单。AI 的费用用你自己的大模型账户支付。</li>
        <li>· 只用你亏得起的钱。不构成投资建议。</li>
      </ul>
      <label className="mt-4 flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="size-4" />
        我已了解风险，自愿使用
      </label>
      <PrimaryButton className="mt-4" disabled={!ok} onClick={onAccept}>
        继续
      </PrimaryButton>
    </>
  );
}

/** USDC on Arbitrum → Hyperliquid's bridge (credited to the same address in about a minute) */
export function DepositSheet({ main, onDone }: { main: LocalAccount; onDone: () => void }) {
  const arb = chainByKey("arb");
  const bal = useQuery({
    queryKey: ["hl", "deposit-bal", main.address],
    queryFn: async () => {
      const pc = publicClientFor(arb);
      const [usdc, eth] = await Promise.all([pc.readContract({ address: ARB_USDC, abi: erc20Abi, functionName: "balanceOf", args: [main.address] }), pc.getBalance({ address: main.address })]);
      return { usdc, eth };
    },
    refetchInterval: 10_000,
  });
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  let raw: bigint | null = null;
  try {
    raw = amount ? parseUnits(amount, 6) : null;
  } catch {}
  const usdc = bal.data?.usdc ?? 0n;
  const noGas = bal.data && bal.data.eth === 0n;
  const problem = raw == null ? null : raw < BigInt(MIN_DEPOSIT * 1e6) ? `最少 ${MIN_DEPOSIT} USDC（少于这个数到不了账，会丢失）` : raw > usdc ? "Arbitrum 上的 USDC 不够" : noGas ? "Arbitrum 上没有 ETH 付网络费" : null;
  const send = async () => {
    if (!raw || problem) return;
    setBusy(true);
    try {
      const wc = createWalletClient({ account: main, chain: arb.chain, transport: http(rpcOf(arb)) });
      const hash = await wc.writeContract({ address: ARB_USDC, abi: erc20Abi, functionName: "transfer", args: [HL_BRIDGE, raw] });
      toast.info("已发出，等 Arbitrum 确认…");
      const rc = await publicClientFor(arb).waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error("交易失败了");
      toast.success("充值已到 Hyperliquid 跨链合约，约 1 分钟后到账", { action: { label: "查看", onClick: () => window.open(explorerTx(arb, hash), "_blank") } });
      onDone();
    } catch (e) {
      toast.error((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="text-center text-[17px] font-semibold">充值到合约账户</div>
      <p className="mt-2 text-center text-[12px] leading-5 text-muted-foreground">从你钱包在 Arbitrum 上的 USDC 转入 Hyperliquid，到账后就能交易</p>
      <div className="mt-4 rounded-2xl bg-muted/70 p-4">
        <div className="flex justify-between text-[13px] text-muted-foreground">
          <span>Arbitrum USDC</span>
          <button type="button" className="font-mono text-foreground" onClick={() => setAmount(formatUnits(usdc, 6))}>
            {bal.data ? formatUnits(usdc, 6) : "…"} 全部
          </button>
        </div>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className="mt-2 w-full bg-transparent font-mono text-[30px] font-semibold outline-none" />
        {problem && <div className="text-[12px] text-down">{problem}</div>}
      </div>
      <ul className="mt-3 space-y-1 text-[12px] leading-5 text-muted-foreground">
        <li>· 只能用 Arbitrum 上的原生 USDC，最少 {MIN_DEPOSIT} USDC，约 1 分钟到账。</li>
        <li>· 需要一点 Arbitrum 上的 ETH 付网络费（几美分）{bal.data ? `，你有 ${Number(formatUnits(bal.data.eth, 18)).toFixed(5)} ETH` : ""}。</li>
        <li>· 钱包里没有 Arbitrum USDC？先在「收款」页选 Arbitrum，从交易所提现过来。</li>
      </ul>
      <PrimaryButton className="mt-4" disabled={!raw || !!problem || busy} onClick={() => void send()}>
        {busy ? "充值中…" : "确认充值"}
      </PrimaryButton>
    </>
  );
}

export function WithdrawSheet({ main, available, onDone }: { main: LocalAccount; available: number; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const v = Number(amount);
  const problem = !amount ? null : !(v > WITHDRAW_FEE) ? `要大于手续费 ${WITHDRAW_FEE} USDC` : v > available ? "可提余额不够" : null;
  const go = async () => {
    if (problem || !(v > 0)) return;
    setBusy(true);
    try {
      await withdraw(main, v);
      toast.success(`已提交提现，约 3～5 分钟到你钱包的 Arbitrum 地址（扣 ${WITHDRAW_FEE} USDC 手续费）`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="text-center text-[17px] font-semibold">提现到钱包</div>
      <div className="mt-4 rounded-2xl bg-muted/70 p-4">
        <div className="flex justify-between text-[13px] text-muted-foreground">
          <span>可提</span>
          <button type="button" className="font-mono text-foreground" onClick={() => setAmount(String(Math.floor(available * 100) / 100))}>
            {usd(available)} 全部
          </button>
        </div>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className="mt-2 w-full bg-transparent font-mono text-[30px] font-semibold outline-none" />
        {problem && <div className="text-[12px] text-down">{problem}</div>}
      </div>
      <p className="mt-3 text-[12px] leading-5 text-muted-foreground">提到你这个钱包在 Arbitrum 上的地址（USDC），Hyperliquid 收 {WITHDRAW_FEE} USDC 手续费。用主钱包签名确认，代理钥匙不能提现。</p>
      <PrimaryButton className="mt-4" disabled={!!problem || !(v > 0) || busy} onClick={() => void go()}>
        {busy ? "提交中…" : "确认提现"}
      </PrimaryButton>
    </>
  );
}

export function AiSettingsSheet({ cfg, onSave, onClear }: { cfg: AiConfig | null; onSave: (c: AiConfig) => Promise<void>; onClear: () => Promise<void> }) {
  const [provider, setProvider] = useState(cfg?.provider ?? "deepseek");
  const [model, setModel] = useState(cfg?.model ?? "");
  const [key, setKey] = useState(cfg?.key ?? "");
  const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? "");
  const [maxLeverage, setMaxLeverage] = useState(cfg?.maxLeverage ?? DEFAULT_RISK.maxLeverage);
  const [maxPct, setMaxPct] = useState(cfg?.maxPct ?? DEFAULT_RISK.maxPct);
  const [minConfidence, setMinConfidence] = useState(cfg?.minConfidence ?? DEFAULT_RISK.minConfidence);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const p = providerOf(provider);
  const draft: AiConfig = { provider, model: model.trim(), key: key.trim(), baseUrl: baseUrl.trim() || undefined, maxLeverage, maxPct, minConfidence };
  const ready = !!draft.key && (provider !== "custom" || (!!draft.baseUrl && !!draft.model));
  const test = async () => {
    setBusy("test");
    try {
      const r = await testAi(draft);
      toast.success(`连通了（模型 ${r.model}）`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="flex items-center justify-center gap-1.5 text-[17px] font-semibold">
        <Robot size={20} />
        AI 设置
      </div>
      <p className="mt-2 text-center text-[12px] leading-5 text-muted-foreground">用你自己的大模型账户，费用由服务商直接向你收。key 用钱包密码加密存在这台手机上。</p>
      <div className="mt-4 text-[13px] font-medium text-muted-foreground">服务商</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {AI_PROVIDERS.map((x) => (
          <button key={x.id} type="button" onClick={() => setProvider(x.id)} className={cn("h-9 rounded-full px-3 text-[13px] font-medium ring-1", provider === x.id ? "bg-foreground text-background ring-foreground" : "bg-card ring-border")}>
            {x.name}
          </button>
        ))}
      </div>
      {p.note && <p className="mt-2 text-[12px] text-muted-foreground">{p.note}</p>}
      {provider === "custom" && (
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="接口地址，例如 https://api.example.com/v1" autoCapitalize="none" spellCheck={false} className="mt-3 h-11 w-full rounded-xl bg-muted px-3 font-mono text-[13px] outline-none" />
      )}
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={p.model ? `模型（默认 ${p.model}）` : "模型名"} autoCapitalize="none" spellCheck={false} className="mt-3 h-11 w-full rounded-xl bg-muted px-3 font-mono text-[13px] outline-none" />
      <div className="mt-3 flex h-11 items-center rounded-xl bg-muted px-3">
        <input value={key} onChange={(e) => setKey(e.target.value)} type={show ? "text" : "password"} placeholder="API key" autoCapitalize="none" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
        <button type="button" aria-label="显示" onClick={() => setShow((v) => !v)} className="text-muted-foreground">
          {show ? <EyeSlash size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {p.keyUrl && (
        <a href={p.keyUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[12px] text-muted-foreground underline underline-offset-4">
          去 {p.name} 申请 key
        </a>
      )}
      <div className="mt-4 text-[13px] font-medium text-muted-foreground">风控（AI 的建议会被限制在这些范围内）</div>
      <Slider label="最大杠杆" value={maxLeverage} min={1} max={20} unit="倍" onChange={setMaxLeverage} />
      <Slider label="单笔最多用可用余额的" value={maxPct} min={5} max={100} step={5} unit="%" onChange={setMaxPct} />
      <Slider label="信心低于多少只提示观望" value={minConfidence} min={30} max={90} step={5} unit="" onChange={setMinConfidence} />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton disabled={!ready || !!busy} onClick={() => void test()}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </GhostButton>
        <PrimaryButton
          disabled={!ready || !!busy}
          onClick={async () => {
            setBusy("save");
            try {
              await onSave(draft);
            } finally {
              setBusy("");
            }
          }}
        >
          保存
        </PrimaryButton>
      </div>
      {cfg && (
        <button type="button" onClick={() => void onClear()} className="mt-3 w-full text-center text-[13px] text-down">
          删除 key
        </button>
      )}
    </>
  );
}

export function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="mt-3 block">
      <span className="flex justify-between text-[13px]">
        <span>{label}</span>
        <span className="font-mono font-semibold">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-foreground" />
    </label>
  );
}

export function CoinPicker({ list, current, onPick }: { list: HlAsset[]; current: string; onPick: (c: string) => void }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => [...list].sort((a, b) => b.volume - a.volume).filter((a) => !q || a.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80), [list, q]);
  return (
    <>
      <div className="mb-3 text-center text-[17px] font-semibold">选择币种</div>
      <label className="flex h-11 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索，如 BTC / SOL / HYPE" autoCapitalize="characters" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
      </label>
      <ul className="mt-2 max-h-[55vh] divide-y divide-border/50 overflow-y-auto">
        {rows.map((a) => {
          const ch = a.prevDay ? (a.mark / a.prevDay - 1) * 100 : 0;
          return (
            <li key={a.name}>
              <button type="button" onClick={() => onPick(a.name)} className={cn("flex w-full items-center gap-3 px-1 py-3 text-left", a.name === current && "font-semibold")}>
                <span className="w-20 text-[15px] font-semibold">{a.name}</span>
                <span className="flex-1 text-[11px] text-muted-foreground">最高 {a.maxLeverage}x · 量 {usd(a.volume / 1e6, 1)}M</span>
                <span className="text-right font-mono text-[13px]">
                  {px(a.mark)}
                  <span className={cn("ml-2", ch >= 0 ? "text-up" : "text-down")}>
                    {ch >= 0 ? "+" : ""}
                    {ch.toFixed(2)}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const ACTION_TEXT: Record<string, { text: string; tone: string }> = {
  long: { text: "建议开多", tone: "bg-up/12 text-up" },
  short: { text: "建议开空", tone: "bg-down/12 text-down" },
  close: { text: "建议平仓", tone: "bg-[#d48806]/12 text-[#b07005]" },
  hold: { text: "继续持有", tone: "bg-muted text-foreground" },
  wait: { text: "建议观望", tone: "bg-muted text-foreground" },
};

export function AiCard({ r, onApply, onClose }: { r: AiResult; onApply?: () => void; onClose?: () => void }) {
  const d = r.decision;
  const a = ACTION_TEXT[d.action];
  const [ago, setAgo] = useState("刚刚");
  useEffect(() => {
    const tick = () => setAgo(`${Math.max(0, Math.round((Date.now() - r.at) / 60_000))} 分钟前`);
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [r.at]);
  return (
    <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="flex items-center gap-2">
        <span className={cn("rounded-full px-3 py-1 text-[13px] font-semibold", a.tone)}>{a.text}</span>
        <span className="text-[13px] font-semibold">{r.coin}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {ago} · {r.model}
        </span>
      </div>
      <div className="mt-3 text-[15px] leading-6 font-medium">{d.summary}</div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
        信心
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", d.confidence >= 70 ? "bg-up" : d.confidence >= 50 ? "bg-[#d48806]" : "bg-down")} style={{ width: `${d.confidence}%` }} />
        </span>
        <span className="font-mono">{d.confidence}</span>
      </div>
      {(d.action === "long" || d.action === "short") && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[12px]">
          <Cell k="入场" v={d.entry ? px(d.entry) : "市价"} />
          <Cell k="止损" v={d.stopLoss ? px(d.stopLoss) : "—"} tone="text-down" />
          <Cell k="止盈" v={d.takeProfit ? px(d.takeProfit) : "—"} tone="text-up" />
          <Cell k="杠杆" v={`${d.leverage}x`} />
          <Cell k="仓位" v={`余额 ${d.sizePct}%`} />
          <Cell k="周期" v={d.horizon || "—"} />
        </div>
      )}
      {d.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px] leading-5">
          {d.reasons.map((x, i) => (
            <li key={i} className="flex gap-1.5">
              <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-up" />
              {x}
            </li>
          ))}
        </ul>
      )}
      {d.risks.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12px] leading-5 text-muted-foreground">
          {d.risks.map((x, i) => (
            <li key={i} className="flex gap-1.5">
              <Warning size={13} className="mt-0.5 shrink-0" />
              {x}
            </li>
          ))}
        </ul>
      )}
      {r.warnings.length > 0 && (
        <div className="mt-3 rounded-xl bg-[#d48806]/10 px-3 py-2 text-[12px] leading-5 text-[#b07005]">
          {r.warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}
      <div className="mt-3 text-[11px] text-muted-foreground">
        本次用了 {r.usage.total.toLocaleString()} 个 token（输入 {r.usage.prompt.toLocaleString()} / 输出 {r.usage.completion.toLocaleString()}），费用以你的服务商账单为准。AI 建议不构成投资建议。
      </div>
      {(onApply || onClose) && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {onClose && <GhostButton onClick={onClose}>不采纳</GhostButton>}
          {onApply && <PrimaryButton onClick={onApply}>{d.action === "close" ? "去平仓" : "按建议填好下单"}</PrimaryButton>}
        </div>
      )}
    </div>
  );
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-muted/70 px-2 py-2">
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className={cn("mt-0.5 truncate font-mono text-[13px] font-semibold", tone)}>{v}</div>
    </div>
  );
}

export const Spinner = () => <CircleNotch size={18} className="animate-spin" />;
