"use client";

import { useEffect, useState } from "react";
import { LinkSimple, PenNib, ShieldWarning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/lib/wallet/i18n";
import { SOL_CHAIN, rpcOf } from "@/lib/wallet/chains";
import { WrongPasswordError, type WalletMeta } from "@/lib/wallet/vault";
import type { DappRequest, RpcError } from "@/lib/wallet/native";
import { getSolPerm, hostOf, isTrusted, revokeSolPerm, setSolPerm } from "@/lib/wallet/dapp-store";
import { looksLikeLogin, type Line, type Risk } from "@/lib/wallet/dapp-decode";
import { LAMPORTS, b58, b64, decodeAddress, signBytes, solKeypairOf } from "@/lib/wallet/sol";
import { broadcast, describeSolTx, looksLikeTransaction, parseWireTx, signWire, signerSlot, simulateChanges, type SendOptions, type SolSim, type SolTxView, type SolWireTx } from "@/lib/wallet/sol-dapp";
import { useVault } from "./wallet-context";
import { ChainGlyph, GhostButton, PrimaryButton } from "./ui";
import { E, Lines, MessageBox, Notes, Origin, Raw, RiskAck, UnlockField, rpcErrorOf } from "./dapp-parts";

/**
 * Solana half of the DApp bridge. The provider script registers a Wallet Standard wallet and forwards its features as
 * `sol_*` requests over the same channel as EIP-1193; byte arrays travel as base64. Accounts go out as
 * `{ address, publicKey(base64) }`, signatures / signed transactions as base64.
 */

export type SolJob = {
  req: DappRequest;
  kind: "solConnect" | "solTx" | "solMsg";
  sol: { txs?: SolWireTx[]; send?: boolean; options?: SendOptions; messages?: Uint8Array[] };
};

const MAX_TXS = 20;
const MAX_MESSAGES = 10;

const accountOut = (address: string) => ({ address, publicKey: b64.encode(decodeAddress(address)!) });

/** The site's connected Solana address, as long as that wallet still exists. */
const connectedSol = (origin: string, wallets: WalletMeta[]) => {
  const p = getSolPerm(origin);
  return p && wallets.some((w) => w.sol === p.address) ? p.address : undefined;
};

function decodeAll(list: unknown, max: number): Uint8Array[] | null {
  if (!Array.isArray(list) || list.length === 0 || list.length > max) return null;
  const out: Uint8Array[] = [];
  for (const s of list) {
    if (typeof s !== "string") return null;
    try {
      out.push(b64.decode(s));
    } catch {
      return null;
    }
  }
  return out;
}

export function handleSol(req: DappRequest, wallets: WalletMeta[], respond: (id: number, result: unknown, error?: RpcError) => void, enqueue: (job: SolJob) => void) {
  const { id, origin, method } = req;
  const p = (req.params && typeof req.params === "object" && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;
  const me = connectedSol(origin, wallets);
  if (typeof p.address === "string" && p.address !== me) return respond(id, null, E.unauthorized);
  switch (method) {
    case "sol_accounts":
      return respond(id, me ? [accountOut(me)] : []);
    case "sol_connect":
      if (me) return respond(id, [accountOut(me)]);
      if (p.silent) return respond(id, []);
      if (!wallets.some((w) => w.sol)) return respond(id, null, { code: 4100, message: "This wallet has no Solana account (private-key wallets have none)." });
      return enqueue({ req, kind: "solConnect", sol: {} });
    case "sol_disconnect":
      revokeSolPerm(origin);
      return respond(id, null);
    case "sol_signTransaction":
    case "sol_signAndSendTransaction": {
      if (!me) return respond(id, null, E.unauthorized);
      const raw = decodeAll(p.txs, MAX_TXS);
      if (!raw) return respond(id, null, E.invalid(`expected 1-${MAX_TXS} base64 transactions`));
      const txs: SolWireTx[] = [];
      for (const b of raw) {
        const tx = parseWireTx(b);
        if (!tx) return respond(id, null, E.invalid("not a valid serialized Solana transaction"));
        if (signerSlot(tx, me) < 0) return respond(id, null, E.invalid("the transaction does not need this account's signature"));
        txs.push(tx);
      }
      const send = method === "sol_signAndSendTransaction";
      return enqueue({ req, kind: "solTx", sol: { txs, send, options: (p.options ?? {}) as SendOptions } });
    }
    case "sol_signMessage": {
      if (!me) return respond(id, null, E.unauthorized);
      const messages = decodeAll(p.messages, MAX_MESSAGES);
      if (!messages) return respond(id, null, E.invalid(`expected 1-${MAX_MESSAGES} base64 messages`));
      if (messages.some(looksLikeTransaction)) return respond(id, null, E.invalid("Refusing to sign a transaction disguised as a message."));
      return enqueue({ req, kind: "solMsg", sol: { messages } });
    }
    default:
      return respond(id, null, E.unsupported(method));
  }
}

type BodyProps = { job: SolJob; finish: (job: SolJob, result: unknown, error?: RpcError) => void; emit: (origin: string, event: string, data: unknown) => void };

export function SolRequestBody(props: BodyProps) {
  const { job } = props;
  return (
    <>
      <Origin origin={job.req.origin} connected={job.kind !== "solConnect"} />
      {job.kind === "solConnect" ? <SolConnect {...props} /> : <SolSign {...props} />}
    </>
  );
}

function SolAccountRow({ address, name }: { address: string; name?: string }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-muted/60 px-3.5 py-3 text-[13px]">
      <span className="flex min-w-0 items-center gap-2">
        <WalletDot address={address} size={20} />
        <span className="truncate font-medium">{name}</span>
        <span className="font-mono text-muted-foreground">{shortAddr(address, 4, 4)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <ChainGlyph chain={SOL_CHAIN} size={16} />
        Solana
      </span>
    </div>
  );
}

function SolConnect({ job, finish }: BodyProps) {
  const { wallets, active } = useVault();
  const list = wallets.filter((w) => w.sol);
  const [pick, setPick] = useState<string | undefined>((active?.sol ? active : list[0])?.sol);
  const origin = job.req.origin;
  const connect = () => {
    if (!pick) return;
    setSolPerm(origin, { address: pick, at: Date.now() });
    finish(job, [accountOut(pick)]);
  };
  return (
    <>
      <h2 className="mt-4 flex items-center justify-center gap-1.5 text-[18px] font-semibold">
        <LinkSimple size={18} weight="bold" />
        {t("cw.dapp.connectTitle")}
      </h2>
      <div className="mt-4 space-y-1.5">
        {list.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setPick(w.sol)}
            className={cn("flex w-full items-center gap-2.5 rounded-2xl border px-3.5 py-3 text-left text-[14px] transition active:scale-[0.99]", pick === w.sol ? "border-foreground bg-foreground/[0.03]" : "border-border")}
          >
            <WalletDot address={w.sol!} size={22} />
            <span className="flex-1 truncate font-medium">{w.name}</span>
            <span className="font-mono text-[12px] text-muted-foreground">{shortAddr(w.sol!, 4, 4)}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between px-1 text-[12px] text-muted-foreground">
        <span>{t("cw.dapp.network")}</span>
        <span className="flex items-center gap-1">
          <ChainGlyph chain={SOL_CHAIN} size={14} />
          Solana
        </span>
      </div>
      <p className="mt-3 rounded-2xl bg-muted/60 px-3.5 py-2.5 text-[12px] leading-5 text-muted-foreground">
        {t("cw.dapp.connectSolNote")}
        {list.length < wallets.length && ` ${t("cw.dapp.connectSolNoKeyWallets")}`}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton onClick={() => finish(job, null, E.rejected)}>{t("cw.dapp.reject")}</GhostButton>
        <PrimaryButton disabled={!pick} onClick={connect}>
          {t("cw.dapp.connect")}
        </PrimaryButton>
      </div>
    </>
  );
}

const RANK: Record<Risk, number> = { none: 0, warn: 1, danger: 2 };
const maxRisk = (rs: Risk[]) => rs.reduce<Risk>((a, r) => (RANK[r] > RANK[a] ? r : a), "none");
const fmtDelta = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1 ? 6 : 4 })}`;
const fmtSol = (lamports: number) => `≈ ${(lamports / LAMPORTS).toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL`;

function messageText(m: Uint8Array): { text: string; hex: boolean } {
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(m);
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(t)) return { text: t, hex: false };
  } catch {}
  return { text: `0x${[...m].map((b) => b.toString(16).padStart(2, "0")).join("")}`, hex: true };
}

/** Sign-In With Solana: "<domain> wants you to sign in with your Solana account:" must name the site that asks. */
const siwsDomain = (text: string) => /^(\S+) wants you to sign in with your Solana account:/.exec(text)?.[1];

type SimState = SolSim | "loading" | "unavailable";

function SolSign({ job, finish }: BodyProps) {
  const vault = useVault();
  const origin = job.req.origin;
  const me = getSolPerm(origin)?.address;
  const wallet = vault.wallets.find((w) => w.sol === me);
  const { txs = [], send = false, options = {}, messages = [] } = job.sol;
  const [views] = useState<SolTxView[]>(() => (me ? txs.map((tx) => describeSolTx(tx, me)) : []));
  const [sims, setSims] = useState<SimState[]>(() => txs.map(() => "loading"));
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me || !wallet) {
      finish(job, null, E.unauthorized);
      return;
    }
    let alive = true;
    const url = rpcOf(SOL_CHAIN);
    txs.forEach((tx, i) =>
      simulateChanges(url, tx, me).then(
        (s) => alive && setSims((ss) => ss.map((x, j) => (j === i ? s : x))),
        () => alive && setSims((ss) => ss.map((x, j) => (j === i ? "unavailable" : x))),
      ),
    );
    return () => {
      alive = false;
    };
    // the job never changes while this sheet is up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const texts = messages.map(messageText);
  const trusted = isTrusted(origin);
  const host = hostOf(origin);
  const wrongDomain = texts.some((m) => {
    const d = siwsDomain(m.text);
    return d != null && d !== host;
  });
  const simFailed = sims.some((s) => typeof s === "object" && !!s.error);
  const risk: Risk =
    job.kind === "solMsg" ? (wrongDomain ? "danger" : trusted ? "none" : "warn") : maxRisk([...views.map((v) => v.risk), simFailed ? "warn" : "none"]);
  const danger = risk === "danger";
  const locked = vault.status === "locked";
  const many = txs.length > 1;

  const confirm = async () => {
    if (!wallet || !me || busy) return;
    setBusy(true);
    setErr("");
    try {
      if (locked) {
        try {
          await vault.unlock(pw);
        } catch (e) {
          setErr(e instanceof WrongPasswordError ? t("cw.dapp.wrongPassword") : t("cw.dapp.unlockFailed"));
          setBusy(false);
          return;
        }
      }
      const secret = vault.secretOf(wallet.id);
      const kp = secret && solKeypairOf(secret);
      if (!kp || kp.address !== me) throw new Error("locked");
      if (job.kind === "solMsg") {
        finish(job, messages.map((m) => b64.encode(signBytes(m, kp))));
        return;
      }
      const signed = txs.map((tx) => signWire(tx, kp));
      if (!send) {
        finish(job, signed.map((s) => b64.encode(s.bytes)));
        return;
      }
      const url = rpcOf(SOL_CHAIN);
      const serial = options.mode === "serial";
      for (let i = 0; i < signed.length; i++) await broadcast(url, signed[i].bytes, signed[i].signature, options, serial && i < signed.length - 1);
      finish(job, signed.map((s) => b64.encode(s.signature)));
      toast.success(many ? t("cw.dapp.txsSent", { n: signed.length }) : t("cw.dapp.txSent"), { description: shortAddr(b58.encode(signed[0].signature), 8, 8) });
    } catch (e) {
      const r = rpcErrorOf(e);
      toast.error(r.message);
      finish(job, null, r);
    }
  };

  const title =
    job.kind === "solMsg"
      ? t("cw.dapp.signTitle")
      : send
        ? many
          ? t("cw.dapp.confirmTxs", { n: txs.length })
          : t("cw.dapp.confirmTx")
        : many
          ? t("cw.dapp.signTxs", { n: txs.length })
          : t("cw.dapp.signTx");
  const confirming = job.kind === "solTx" && send;

  return (
    <>
      <h2 className={cn("mt-4 flex items-center justify-center gap-1.5 text-[18px] font-semibold", danger && "text-down")}>
        {danger ? <ShieldWarning size={20} weight="fill" /> : job.kind === "solMsg" ? <PenNib size={18} weight="bold" /> : null}
        {title}
      </h2>

      <div className="mt-4 max-h-[52vh] space-y-2 overflow-y-auto">
        {me && <SolAccountRow address={me} name={wallet?.name} />}
        {job.kind === "solMsg" ? (
          <>
            {texts.map((m, i) => (
              <MessageBox key={i} text={m.text} mono={m.hex} />
            ))}
            <Notes
              risk={risk}
              notes={[
                wrongDomain
                  ? t("cw.dapp.siwsWrongDomain", { host })
                  : texts.some((m) => looksLikeLogin(m.text) || siwsDomain(m.text))
                    ? t("cw.dapp.loginNote")
                    : t("cw.dapp.signFreeNote"),
              ]}
            />
          </>
        ) : (
          txs.map((tx, i) => <TxCard key={i} index={many ? i + 1 : 0} tx={tx} view={views[i]} sim={sims[i]} danger={danger} send={send} />)
        )}
      </div>

      {danger && <RiskAck ack={ack} onChange={setAck} />}
      {locked && (
        <UnlockField
          pw={pw}
          err={err}
          onChange={(v) => {
            setPw(v);
            setErr("");
          }}
        />
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton onClick={() => finish(job, null, E.rejected)}>{t("cw.dapp.reject")}</GhostButton>
        <PrimaryButton tone={danger ? "danger" : "default"} disabled={busy || (danger && !ack) || (locked && !pw)} onClick={() => void confirm()}>
          {busy
            ? send
              ? t("cw.dapp.sending")
              : t("cw.dapp.signing")
            : locked
              ? confirming
                ? t("cw.dapp.unlockConfirm")
                : t("cw.dapp.unlockSign")
              : confirming
                ? t("common.confirm")
                : t("cw.dapp.sign")}
        </PrimaryButton>
      </div>
    </>
  );
}

function TxCard({ index, tx, view, sim, danger, send }: { index: number; tx: SolWireTx; view?: SolTxView; sim: SimState; danger: boolean; send: boolean }) {
  if (!view) return null;
  const changes: Line[] =
    typeof sim === "object" && !sim.error
      ? sim.changes.length
        ? sim.changes.map((c) => ({ label: c.symbol, value: fmtDelta(c.delta), mono: true, tone: c.delta > 0 ? "up" : "down" }))
        : [{ label: t("cw.dapp.balanceChange"), value: t("cw.dapp.none") }]
      : [];
  const notes = [
    ...view.notes,
    ...(sim === "unavailable" ? [t("cw.dapp.simUnavailable")] : []),
    ...(typeof sim === "object" && sim.error ? [index > 1 ? t("cw.dapp.solSimFailedChained", { err: sim.error }) : t("cw.dapp.solSimFailed", { err: sim.error })] : []),
    ...(!send && index <= 1 ? [t("cw.dapp.siteSends")] : []),
  ];
  return (
    <div className="space-y-2">
      {index > 0 && <div className="px-1 pt-1 text-[12px] font-medium text-muted-foreground">{t("cw.dapp.txIndex", { n: index })}</div>}
      {sim === "loading" ? (
        <div className="flex h-11 items-center rounded-2xl bg-muted/60 px-3.5 text-[13px] text-muted-foreground">{t("cw.dapp.simulating")}</div>
      ) : (
        changes.length > 0 && (
          <div>
            <div className="px-1 pb-1 text-[12px] text-muted-foreground">{t("cw.dapp.estChanges")}</div>
            <Lines lines={changes} />
          </div>
        )
      )}
      <Lines lines={[...view.lines, ...(view.feeLamports ? [{ label: t("cw.dapp.feeEst"), value: fmtSol(view.feeLamports), mono: true }] : [])]} danger={danger} />
      <Notes risk={view.risk === "none" && typeof sim === "object" && sim.error ? "warn" : view.risk} notes={notes} />
      <Raw label={t("cw.dapp.rawData")} text={b64.encode(tx.bytes)} />
    </div>
  );
}
