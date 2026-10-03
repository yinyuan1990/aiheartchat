"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createWalletClient, getAddress, http, isAddress, isHex, numberToHex, type Address, type Hex } from "viem";
import { CaretDown, CaretUp, Eye, EyeSlash, Globe, Info, LinkSimple, PenNib, SealCheck, ShieldWarning, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { chainById, publicClientFor, type WalletChain } from "@/lib/wallet/chains";
import { accountOf, WrongPasswordError } from "@/lib/wallet/vault";
import { hasFeature, nativeBridge, onNativePush, type DappRequest, type RpcError } from "@/lib/wallet/native";
import { addRecent, getPerm, hostOf, isTrusted, loadDappStore, revokePerm, setPerm, toggleFav } from "@/lib/wallet/dapp-store";
import { describeTx, describeTyped, looksLikeLogin, readableMessage, type Line, type Risk, type TxView, type TypedData, type TypedView } from "@/lib/wallet/dapp-decode";
import { useVault } from "./wallet-context";
import { BottomSheet, ChainGlyph, GhostButton, PrimaryButton } from "./ui";

/**
 * Answers EIP-1193 requests that the App's DApp browser forwards to the wallet page. Read-only methods are answered
 * silently; connect / sign / send raise a sheet over the DApp. Every way of closing a sheet answers 4001 so the site
 * never hangs (Ave leaves Arm's "Sign in" spinning forever — the thing we must not copy).
 */

const E = {
  rejected: { code: 4001, message: "User rejected the request." },
  unauthorized: { code: 4100, message: "The requested account and/or method has not been authorized by the user." },
  unsupported: (what: string) => ({ code: 4200, message: `The wallet does not support ${what}.` }),
  unknownChain: (id: unknown) => ({ code: 4902, message: `Unrecognized chain ID ${String(id)}.` }),
  invalid: (msg: string) => ({ code: -32602, message: msg }),
};

const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
]);

const DEFAULT_CHAIN = 5042;
type Kind = "connect" | "sign" | "typed" | "tx";
type Job = { req: DappRequest; kind: Kind };

/** Chain picked by sites that have not connected yet (connected sites keep theirs in the permission record). */
const sessionChain = new Map<string, number>();

const paramsOf = (req: DappRequest): unknown[] => (Array.isArray(req.params) ? req.params : req.params == null ? [] : [req.params]);

function rpcErrorOf(e: unknown): RpcError {
  const x = e as { code?: unknown; shortMessage?: string; details?: string; message?: string };
  const message = (x.shortMessage ?? x.details ?? x.message ?? "Internal error").split("\n")[0];
  return { code: typeof x.code === "number" ? x.code : -32603, message };
}

export function DappApprover({ onOverlay }: { onOverlay: (on: boolean) => void }) {
  const vault = useVault();
  const ref = useRef(vault);
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef(jobs);
  useEffect(() => {
    ref.current = vault;
    jobsRef.current = jobs;
  });
  const ready = vault.status !== "loading";
  const current = jobs[0];
  const showing = !!current;

  const respond = useCallback((id: number, result: unknown, error?: RpcError) => {
    nativeBridge()?.dappRespond?.(error ? { id, error } : { id, result: result ?? null });
  }, []);
  const emit = (origin: string, event: string, data: unknown) => nativeBridge()?.dappEmit?.({ origin, event, data });

  const chainOf = (origin: string) => getPerm(origin)?.chainId ?? sessionChain.get(origin) ?? DEFAULT_CHAIN;
  const accountsOf = (origin: string): Address[] => {
    const p = getPerm(origin);
    return p && ref.current.wallets.some((w) => w.address === p.address) ? [p.address] : [];
  };
  const permissionsOf = (origin: string) => {
    const acc = accountsOf(origin);
    return acc.length ? [{ parentCapability: "eth_accounts", invoker: origin, caveats: [{ type: "restrictReturnedAccounts", value: acc }] }] : [];
  };

  const handle = useCallback(
    async (req: DappRequest) => {
      const { id, origin, method } = req;
      const params = paramsOf(req);
      const enqueue = (kind: Kind) => setJobs((js) => [...js, { req, kind }]);
      try {
        switch (method) {
          case "eth_chainId":
            return respond(id, numberToHex(chainOf(origin)));
          case "net_version":
            return respond(id, String(chainOf(origin)));
          case "eth_accounts":
            return respond(id, accountsOf(origin));
          case "eth_coinbase":
            return respond(id, accountsOf(origin)[0] ?? null);
          case "web3_clientVersion":
            return respond(id, "XinZhiYinWallet/1");
          case "eth_requestAccounts":
          case "wallet_requestPermissions": {
            if (accountsOf(origin).length) return respond(id, method === "eth_requestAccounts" ? accountsOf(origin) : permissionsOf(origin));
            if (!ref.current.wallets.length) return respond(id, null, E.unauthorized);
            return enqueue("connect");
          }
          case "wallet_getPermissions":
            return respond(id, permissionsOf(origin));
          case "wallet_revokePermissions":
            revokePerm(origin);
            emit(origin, "accountsChanged", []);
            return respond(id, null);
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain": {
            const raw = (params[0] as { chainId?: string } | undefined)?.chainId;
            const cid = raw != null ? Number(raw) : NaN;
            if (!chainById(cid)) return respond(id, null, method === "wallet_switchEthereumChain" ? E.unknownChain(raw) : E.unsupported(`chain ${raw}`));
            if (cid !== chainOf(origin)) {
              const p = getPerm(origin);
              if (p) setPerm(origin, { ...p, chainId: cid });
              else sessionChain.set(origin, cid);
              emit(origin, "chainChanged", numberToHex(cid));
            }
            return respond(id, null);
          }
          case "personal_sign":
          case "eth_signTypedData_v3":
          case "eth_signTypedData_v4":
          case "eth_sendTransaction":
            if (!accountsOf(origin).length) return respond(id, null, E.unauthorized);
            return enqueue(method === "personal_sign" ? "sign" : method === "eth_sendTransaction" ? "tx" : "typed");
          case "eth_sign":
            return respond(id, null, E.unsupported("eth_sign (blind signing is disabled)"));
          default: {
            if (!READ_METHODS.has(method)) return respond(id, null, E.unsupported(method));
            const c = chainById(chainOf(origin))!;
            const r = await publicClientFor(c).request({ method, params } as never);
            return respond(id, r);
          }
        }
      } catch (e) {
        respond(id, null, rpcErrorOf(e));
      }
    },
    // chainOf / accountsOf read refs and the module store, so they never go stale
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [respond],
  );

  const finish = useCallback(
    (job: Job, result: unknown, error?: RpcError) => {
      respond(job.req.id, result, error);
      setJobs((js) => js.filter((j) => j !== job));
    },
    [respond],
  );

  useEffect(() => {
    if (!ready || !hasFeature("dapp")) return;
    let alive = true;
    const off = onNativePush((m) => {
      if (m.push === "dappRequest") void handle(m.req);
      else if (m.push === "dappCancel") {
        const j = jobsRef.current[0];
        if (j) finish(j, null, E.rejected);
      } else if (m.push === "dappReset") {
        jobsRef.current.forEach((j) => respond(j.req.id, null, E.rejected));
        jobsRef.current = [];
        setJobs([]);
      } else if (m.push === "dappVisited") addRecent(m.url, m.title);
      else if (m.push === "dappFavorite") nativeBridge()?.toast?.(toggleFav(m.url, m.title) ? "已收藏" : "已取消收藏");
    });
    void loadDappStore().then(() => alive && nativeBridge()?.dappReady?.());
    return () => {
      alive = false;
      off();
    };
  }, [ready, handle, finish, respond]);

  // raise the wallet layer right away; lower it after the sheet's slide-out
  useEffect(() => {
    if (showing) {
      onOverlay(true);
      nativeBridge()?.dappShow?.(true);
      return;
    }
    const t = setTimeout(() => {
      onOverlay(false);
      nativeBridge()?.dappShow?.(false);
    }, 220);
    return () => clearTimeout(t);
  }, [showing, onOverlay]);

  return (
    <BottomSheet open={showing} onClose={() => current && finish(current, null, E.rejected)}>
      {current && <RequestBody key={current.req.id} job={current} chain={chainById(chainOf(current.req.origin)) ?? chainById(DEFAULT_CHAIN)!} finish={finish} emit={emit} />}
    </BottomSheet>
  );
}

type BodyProps = { job: Job; chain: WalletChain; finish: (job: Job, result: unknown, error?: RpcError) => void; emit: (origin: string, event: string, data: unknown) => void };

function RequestBody(props: BodyProps) {
  const { job } = props;
  return (
    <>
      <Origin origin={job.req.origin} connected={job.kind !== "connect"} />
      {job.kind === "connect" ? <ConnectBody {...props} /> : <SignFlow {...props} />}
    </>
  );
}

function Origin({ origin, connected }: { origin: string; connected: boolean }) {
  const trusted = isTrusted(origin);
  const [icon, setIcon] = useState(true);
  const insecure = origin.startsWith("http:");
  return (
    <div className="flex flex-col items-center text-center">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${origin}/favicon.ico`} alt="" onError={() => setIcon(false)} className="size-14 rounded-2xl bg-muted object-cover shadow-sm ring-1 ring-border" />
      ) : (
        <span className="flex size-14 items-center justify-center rounded-2xl bg-muted ring-1 ring-border">
          <Globe size={26} weight="duotone" />
        </span>
      )}
      <div className="mt-2 flex max-w-full items-center gap-1 text-[15px] font-semibold">
        <span className="truncate">{hostOf(origin)}</span>
        {trusted && <SealCheck size={16} weight="fill" className="shrink-0 text-up" />}
      </div>
      <div className={cn("text-[12px]", trusted ? "text-muted-foreground" : "text-[#d48806]")}>
        {trusted ? `Arm 官方${connected ? " · 已连接" : ""}` : insecure ? "不安全的连接（http）" : connected ? "第三方网站 · 已连接" : "第三方网站 · 不在推荐列表里"}
      </div>
    </div>
  );
}

function AccountRow({ address, name, chain }: { address: Address; name?: string; chain: WalletChain }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-muted/60 px-3.5 py-3 text-[13px]">
      <span className="flex min-w-0 items-center gap-2">
        <WalletDot address={address} size={20} />
        <span className="truncate font-medium">{name}</span>
        <span className="font-mono text-muted-foreground">{shortAddr(address, 4, 4)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <ChainGlyph chain={chain} size={16} />
        {chain.name}
      </span>
    </div>
  );
}

function ConnectBody({ job, chain, finish, emit }: BodyProps) {
  const { wallets, active } = useVault();
  const [pick, setPick] = useState<Address | undefined>(active?.address ?? wallets[0]?.address);
  const origin = job.req.origin;
  const connect = () => {
    if (!pick) return;
    setPerm(origin, { address: pick, chainId: chain.chain.id, at: Date.now() });
    sessionChain.delete(origin);
    const result =
      job.req.method === "eth_requestAccounts" ? [pick] : [{ parentCapability: "eth_accounts", invoker: origin, caveats: [{ type: "restrictReturnedAccounts", value: [pick] }] }];
    finish(job, result);
    emit(origin, "accountsChanged", [pick]);
  };
  return (
    <>
      <h2 className="mt-4 flex items-center justify-center gap-1.5 text-[18px] font-semibold">
        <LinkSimple size={18} weight="bold" />
        连接钱包
      </h2>
      <div className="mt-4 space-y-1.5">
        {wallets.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setPick(w.address)}
            className={cn("flex w-full items-center gap-2.5 rounded-2xl border px-3.5 py-3 text-left text-[14px] transition active:scale-[0.99]", pick === w.address ? "border-foreground bg-foreground/[0.03]" : "border-border")}
          >
            <WalletDot address={w.address} size={22} />
            <span className="flex-1 truncate font-medium">{w.name}</span>
            <span className="font-mono text-[12px] text-muted-foreground">{shortAddr(w.address, 4, 4)}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between px-1 text-[12px] text-muted-foreground">
        <span>网络</span>
        <span className="flex items-center gap-1">
          <ChainGlyph chain={chain} size={14} />
          {chain.name}
        </span>
      </div>
      <p className="mt-3 flex items-start gap-1.5 rounded-2xl bg-muted/60 px-3.5 py-2.5 text-[12px] leading-5 text-muted-foreground">
        <Info size={14} className="mt-0.5 shrink-0" />
        网站会看到你的地址和余额。连接不会授权它动你的资产，之后每次签名、交易都要你确认。可以在「DApp → 已连接的网站」里断开。
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton onClick={() => finish(job, null, E.rejected)}>拒绝</GhostButton>
        <PrimaryButton disabled={!pick} onClick={connect}>
          连接
        </PrimaryButton>
      </div>
    </>
  );
}

type Prepared =
  | { kind: "sign"; address: Address; text: string; raw: string; isHex: boolean }
  | { kind: "typed"; address: Address; data: TypedData; view: TypedView }
  | { kind: "tx"; address: Address; to?: Address; data?: Hex; value: bigint; nonce?: number; view: TxView; fees: Fees | null; feeText: string; simError?: string };
type Fees = { gas: bigint; maxFee: bigint; tip: bigint; legacy: boolean };

const fmtFee = (wei: bigint, chain: WalletChain) => {
  const nc = chain.chain.nativeCurrency;
  const n = Number(wei) / 10 ** nc.decimals;
  return `≈ ${n > 0 && n < 0.0001 ? "<0.0001" : n.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${nc.symbol}`;
};
const big = (v: unknown): bigint | undefined => {
  if (v == null || v === "") return undefined;
  try {
    return BigInt(v as string);
  } catch {
    return undefined;
  }
};

async function prepare(job: Job, chain: WalletChain, connected: Address): Promise<Prepared | RpcError> {
  const params = paramsOf(job.req);
  const trusted = isTrusted(job.req.origin);
  const same = (a: unknown) => typeof a === "string" && isAddress(a) && getAddress(a) === connected;

  if (job.kind === "sign") {
    // some sites send [address, message]
    let [msg, addr] = params as [string, string];
    if (same(msg) && !same(addr)) [msg, addr] = [addr, msg];
    if (typeof msg !== "string") return E.invalid("personal_sign: message must be a string");
    if (addr != null && !same(addr)) return E.unauthorized;
    const r = readableMessage(msg);
    return { kind: "sign", address: connected, text: r.text, raw: msg, isHex: isHex(msg) };
  }

  if (job.kind === "typed") {
    const [addr, payload] = params as [string, unknown];
    if (!same(addr)) return E.unauthorized;
    let data: TypedData;
    try {
      data = (typeof payload === "string" ? JSON.parse(payload) : payload) as TypedData;
    } catch {
      return E.invalid("typed data is not valid JSON");
    }
    if (!data?.types || !data.primaryType || !data.message) return E.invalid("typed data is missing types / primaryType / message");
    return { kind: "typed", address: connected, data, view: describeTyped(data, chain.chain.id, trusted) };
  }

  const tx = (params[0] ?? {}) as Record<string, unknown>;
  if (tx.from != null && !same(tx.from)) return E.unauthorized;
  const txChain = big(tx.chainId);
  if (txChain != null && Number(txChain) !== chain.chain.id) return E.invalid(`chainId ${txChain} does not match the current chain ${chain.chain.id}`);
  const to = typeof tx.to === "string" && isAddress(tx.to) ? getAddress(tx.to) : undefined;
  const data = typeof tx.data === "string" ? (tx.data as Hex) : typeof tx.input === "string" ? (tx.input as Hex) : undefined;
  const value = big(tx.value) ?? 0n;
  const pc = publicClientFor(chain);
  const view = await describeTx(chain, { from: connected, to, data, value }, trusted);

  let simError: string | undefined;
  let gas = big(tx.gas ?? tx.gasLimit);
  if (gas == null) {
    try {
      gas = ((await pc.estimateGas({ account: connected, to, data, value })) * 12n) / 10n;
    } catch (e) {
      simError = rpcErrorOf(e).message;
      gas = 300_000n;
    }
  }
  let fees: Fees | null = null;
  try {
    const maxFee = big(tx.maxFeePerGas);
    const gasPrice = big(tx.gasPrice);
    if (maxFee != null) fees = { gas, maxFee, tip: big(tx.maxPriorityFeePerGas) ?? 0n, legacy: false };
    else if (gasPrice != null) fees = { gas, maxFee: gasPrice, tip: 0n, legacy: true };
    else {
      try {
        const f = await pc.estimateFeesPerGas();
        fees = { gas, maxFee: f.maxFeePerGas, tip: f.maxPriorityFeePerGas, legacy: false };
      } catch {
        fees = { gas, maxFee: await pc.getGasPrice(), tip: 0n, legacy: true };
      }
    }
  } catch {
    fees = null;
  }
  const nonce = big(tx.nonce);
  return { kind: "tx", address: connected, to, data, value, nonce: nonce != null ? Number(nonce) : undefined, view, fees, feeText: fees ? fmtFee(fees.gas * fees.maxFee, chain) : "—", simError };
}

function SignFlow({ job, chain, finish }: BodyProps) {
  const vault = useVault();
  const connected = getPerm(job.req.origin)?.address;
  const wallet = vault.wallets.find((w) => w.address === connected);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!connected) {
      finish(job, null, E.unauthorized);
      return;
    }
    prepare(job, chain, connected).then(
      (p) => {
        if (!alive) return;
        if ("code" in p) finish(job, null, p);
        else setPrep(p);
      },
      (e) => alive && finish(job, null, rpcErrorOf(e)),
    );
    return () => {
      alive = false;
    };
  }, [job, chain, connected, finish]);

  const risk: Risk = !prep ? "none" : prep.kind === "sign" ? (isTrusted(job.req.origin) ? "none" : "warn") : prep.kind === "tx" && prep.simError && prep.view.risk === "none" ? "warn" : prep.view.risk;
  const locked = vault.status === "locked";

  const confirm = async () => {
    if (!prep || !wallet || busy) return;
    setBusy(true);
    setErr("");
    try {
      if (locked) {
        try {
          await vault.unlock(pw);
        } catch (e) {
          setErr(e instanceof WrongPasswordError ? "密码不对" : "解锁失败，请重试");
          setBusy(false);
          return;
        }
      }
      const secret = vault.secretOf(wallet.id);
      if (!secret) throw new Error("locked");
      const account = accountOf(secret);
      if (prep.kind === "sign") {
        finish(job, await account.signMessage({ message: prep.isHex ? { raw: prep.raw as Hex } : prep.raw }));
      } else if (prep.kind === "typed") {
        const d = prep.data;
        const domain = { ...(d.domain ?? {}) } as Record<string, unknown>;
        if (domain.chainId != null) domain.chainId = Number(domain.chainId);
        finish(job, await account.signTypedData({ domain, types: d.types, primaryType: d.primaryType, message: d.message } as never));
      } else {
        if (!prep.fees) throw new Error("没拿到网络费，请稍后再试");
        const wc = createWalletClient({ account, chain: chain.chain, transport: http(chain.chain.rpcUrls.default.http[0]) });
        const base = { to: prep.to, data: prep.data, value: prep.value, gas: prep.fees.gas, nonce: prep.nonce };
        const hash = prep.fees.legacy
          ? await wc.sendTransaction({ ...base, gasPrice: prep.fees.maxFee } as never)
          : await wc.sendTransaction({ ...base, maxFeePerGas: prep.fees.maxFee, maxPriorityFeePerGas: prep.fees.tip } as never);
        finish(job, hash);
        toast.success("交易已发出");
      }
    } catch (e) {
      const r = rpcErrorOf(e);
      toast.error(r.message);
      finish(job, null, r);
    }
  };

  const title = !prep ? "" : prep.kind === "sign" ? "签名请求" : prep.view.title;
  const danger = risk === "danger";

  return (
    <>
      <h2 className={cn("mt-4 flex items-center justify-center gap-1.5 text-[18px] font-semibold", danger && "text-down")}>
        {danger ? <ShieldWarning size={20} weight="fill" /> : job.kind === "tx" ? null : <PenNib size={18} weight="bold" />}
        {prep ? title : job.kind === "tx" ? "确认交易" : "签名请求"}
      </h2>

      {!prep ? (
        <div className="mt-4 space-y-2">
          <div className="h-12 animate-pulse rounded-2xl bg-muted" />
          <div className="h-24 animate-pulse rounded-2xl bg-muted" />
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {connected && <AccountRow address={connected} name={wallet?.name} chain={chain} />}
          {prep.kind === "sign" && <MessageBox text={prep.text} mono={prep.isHex && prep.text.startsWith("0x")} />}
          {prep.kind !== "sign" && <Lines lines={prep.view.lines} danger={danger} />}
          {prep.kind === "tx" && (
            <Lines lines={[{ label: "网络费（最多）", value: prep.feeText, mono: true }]} />
          )}
          {prep.kind === "typed" && <Raw label="签名原文" text={JSON.stringify(prep.data.message, null, 2)} />}
          {prep.kind === "tx" && prep.data && prep.data !== "0x" && <Raw label="原始数据" text={`to ${prep.to}\n${prep.data}`} />}
          <Notes
            risk={risk}
            notes={[
              ...(prep.kind === "sign"
                ? [looksLikeLogin(prep.text) ? "这是登录签名：不花钱，也不会授权任何人动你的资产。" : "签名不花钱，但只给你信任的网站签。"]
                : prep.view.notes),
              ...(prep.kind === "tx" && prep.simError ? [`模拟执行失败：${prep.simError}。这笔交易很可能会失败（失败也要付网络费）。`] : []),
            ]}
          />
        </div>
      )}

      {danger && prep && (
        <label className="mt-3 flex items-center gap-2 px-1 text-[13px]">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="size-4 accent-[var(--down)]" />
          我知道风险，仍要继续
        </label>
      )}

      {locked && prep && (
        <div className="mt-3">
          <div className={cn("flex h-12 items-center rounded-2xl bg-card px-4 ring-1 transition", err ? "ring-down" : "ring-border focus-within:ring-foreground")}>
            <input
              type={showPw ? "text" : "password"}
              value={pw}
              autoComplete="current-password"
              onChange={(e) => {
                setPw(e.target.value);
                setErr("");
              }}
              placeholder="输入钱包密码"
              className="flex-1 bg-transparent text-[15px] outline-none"
            />
            <button type="button" aria-label={showPw ? "隐藏密码" : "显示密码"} onClick={() => setShowPw((v) => !v)} className="text-muted-foreground">
              {showPw ? <EyeSlash size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <div className="mt-1 h-4 px-1 text-[12px] text-down">{err}</div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton onClick={() => finish(job, null, E.rejected)}>拒绝</GhostButton>
        <PrimaryButton tone={danger ? "danger" : "default"} disabled={!prep || busy || (danger && !ack) || (locked && !pw)} onClick={() => void confirm()}>
          {busy ? (job.kind === "tx" ? "发送中…" : "签名中…") : locked ? (job.kind === "tx" ? "解锁并确认" : "解锁并签名") : job.kind === "tx" ? "确认" : "签名"}
        </PrimaryButton>
      </div>
    </>
  );
}

function Lines({ lines, danger }: { lines: Line[]; danger?: boolean }) {
  if (!lines.length) return null;
  return (
    <dl className={cn("divide-y divide-border/60 rounded-2xl px-3.5 text-[13px]", danger ? "bg-down/8 ring-1 ring-down/30" : "bg-muted/60")}>
      {lines.map((l, i) => (
        <div key={i} className="flex items-start justify-between gap-4 py-2.5">
          <dt className="shrink-0 text-muted-foreground">{l.label}</dt>
          <dd className={cn("min-w-0 text-right break-all", l.mono && "font-mono", l.tone === "up" && "text-up", l.tone === "down" && "text-down")}>{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MessageBox({ text, mono }: { text: string; mono?: boolean }) {
  const [full, setFull] = useState(false);
  const long = text.length > 120 || text.split("\n").length > 3;
  return (
    <div className="rounded-2xl bg-muted/60 px-3.5 py-3">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        签名内容
        {long && (
          <button type="button" onClick={() => setFull((v) => !v)} className="flex items-center gap-0.5">
            {full ? "收起" : "展开"}
            {full ? <CaretUp size={12} /> : <CaretDown size={12} />}
          </button>
        )}
      </div>
      <pre className={cn("mt-1.5 max-h-[40vh] overflow-y-auto text-[12.5px] leading-5 break-all whitespace-pre-wrap", mono ? "font-mono" : "font-sans", !full && long && "line-clamp-3")}>{text}</pre>
    </div>
  );
}

function Raw({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl bg-muted/60 px-3.5 text-[13px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full justify-between py-2.5 text-muted-foreground">
        {label}
        {open ? <CaretUp size={14} /> : <CaretDown size={14} />}
      </button>
      {open && <pre className="max-h-[40vh] overflow-y-auto pb-3 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground">{text}</pre>}
    </div>
  );
}

function Notes({ risk, notes }: { risk: Risk; notes: string[] }) {
  if (!notes.length) return null;
  const cls = risk === "danger" ? "bg-down/10 text-down" : risk === "warn" ? "bg-[#d48806]/10 text-[#b07005] dark:text-[#e0a030]" : "bg-up/10 text-up";
  const Icon = risk === "none" ? Info : Warning;
  return (
    <div className={cn("space-y-1 rounded-2xl px-3.5 py-2.5 text-[12px] leading-5", cls)}>
      {notes.map((n, i) => (
        <p key={i} className="flex items-start gap-1.5">
          <Icon size={14} className="mt-0.5 shrink-0" />
          {n}
        </p>
      ))}
    </div>
  );
}
