"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  accountOf,
  addWallet as vaultAdd,
  createVault,
  quickPassword,
  readStored,
  setQuick as vaultSetQuick,
  removeWallet as vaultRemove,
  saveMeta,
  unlockVault,
  type Secret,
  type Unlocked,
  type WalletMeta,
} from "@/lib/wallet/vault";
import { chainByKey, isSolana, isTon, isTron, type WalletChain } from "@/lib/wallet/chains";
import { solAddressOf, solKeypairOf, type SolKeypair } from "@/lib/wallet/sol";
import { tronAddressOf, tronKeyOf, type TronKey } from "@/lib/wallet/tron";
import { sameTonAddress, tonAddressOf, tonKeyOf, type TonKey } from "@/lib/wallet/ton";

/** The wallet's address on that chain (undefined: none, e.g. Solana / TON of a private-key wallet) */
export const addressOn = (w: WalletMeta, c: WalletChain) => (isSolana(c) ? w.sol : isTron(c) ? w.trx : isTon(c) ? w.ton : w.address);
import { loadPayee, payeeSupported, publishPayee } from "@/lib/wallet/payee";
import { toast } from "sonner";

type Status = "loading" | "empty" | "locked" | "unlocked";

type Ctx = {
  status: Status;
  wallets: WalletMeta[];
  active: WalletMeta | null;
  chain: WalletChain;
  setChain: (key: string) => void;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  /** First wallet sets the password; later ones need the vault unlocked. Returns the existing wallet on a duplicate import. */
  addSecret: (name: string, secret: Secret, password?: string) => Promise<{ duplicate?: WalletMeta }>;
  switchTo: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Active wallet's address on the selected chain (Solana: undefined for private-key wallets). */
  address: string | undefined;
  /** Signing account of the active wallet; throws while locked. */
  account: () => ReturnType<typeof accountOf>;
  /** Solana signer of the active wallet; throws while locked or for private-key wallets. */
  solKeypair: () => SolKeypair;
  /** TRON signer of the active wallet; throws while locked. */
  tronKey: () => TronKey;
  /** TON signer of the active wallet; throws while locked or for private-key wallets. */
  tonKey: () => TonKey;
  secretOf: (id: string) => Secret | null;
  /** 免密码使用: opens without the password and does not auto-lock in the background */
  quick: boolean;
  /** password (already verified) = on, null = off */
  setQuick: (password: string | null) => Promise<void>;
};

const WalletCtx = createContext<Ctx | null>(null);
const CHAIN_KEY = "arm.wallet.chain";
const AUTO_LOCK_MS = 5 * 60_000;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [wallets, setWallets] = useState<WalletMeta[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [chainKey, setChainKey] = useState("arc");
  const [quickOn, setQuickOn] = useState(false);
  const unlocked = useRef<Unlocked | null>(null);

  const lock = useCallback(() => {
    unlocked.current = null;
    setStatus((s) => (s === "unlocked" ? "locked" : s));
  }, []);

  // Lock after 5 minutes in the background (App switched away / tab hidden).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onVis = () => {
      if (document.visibilityState === "hidden" && !unlocked.current?.quick) t = setTimeout(lock, AUTO_LOCK_MS);
      else if (t) clearTimeout(t);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (t) clearTimeout(t);
    };
  }, [lock]);

  const unlock = useCallback(async (password: string) => {
    const r = await unlockVault(password);
    unlocked.current = r.unlocked;
    // vaults from before Solana / TRON support: derive the missing addresses once and keep them in the metadata
    let list = r.wallets;
    if (list.some((w) => (w.kind === "mnemonic" && (!w.sol || !w.ton)) || !w.trx)) {
      list = list.map((w) => {
        const s = r.unlocked.plain.secrets[w.id];
        return !s ? w : { ...w, sol: w.sol ?? solAddressOf(s) ?? undefined, trx: w.trx ?? tronAddressOf(s), ton: w.ton ?? tonAddressOf(s) ?? undefined };
      });
      await saveMeta(r.unlocked, list, r.active).catch(() => {});
    }
    setWallets(list);
    setActiveId(r.active);
    setQuickOn(!!r.unlocked.quick);
    setStatus("unlocked");
  }, []);

  useEffect(() => {
    let alive = true;
    readStored().then(async (s) => {
      if (!alive) return;
      try {
        const k = localStorage.getItem(CHAIN_KEY);
        if (k) setChainKey(chainByKey(k).key);
      } catch {}
      if (!s) return setStatus("empty");
      setWallets(s.wallets);
      setActiveId(s.active);
      // 免密码使用: stay on "loading" and open straight away instead of showing the unlock screen; a stored password
      // that no longer opens the vault falls back to it
      const pw = await quickPassword();
      if (!alive) return;
      if (!pw) return setStatus("locked");
      unlock(pw).catch(() => alive && setStatus("locked"));
    });
    return () => {
      alive = false;
    };
  }, [unlock]);

  // 「允许好友给我转账」开着时，公开的收款地址跟着当前钱包走（切换 / 新建 / 删除钱包后重新签名公开）
  const payeeSynced = useRef("");
  useEffect(() => {
    if (status !== "unlocked" || !payeeSupported()) return;
    const w = wallets.find((x) => x.id === activeId);
    const secret = w && unlocked.current?.plain.secrets[w.id];
    if (!w || !secret || payeeSynced.current === w.id) return;
    payeeSynced.current = w.id;
    void (async () => {
      try {
        const p = await loadPayee();
        if (!p || !(p.evm || p.sol || p.trx || p.ton)) return;
        const same = p.evm?.toLowerCase() === w.address.toLowerCase() && (p.sol ?? null) === (w.sol ?? null) && (!w.trx || p.trx === w.trx) && (!w.ton || p.ton === undefined || sameTonAddress(p.ton, w.ton));
        if (same) return;
        await publishPayee(p.userId, secret);
        toast.success(`好友转账的收款地址已换成「${w.name}」`);
      } catch {
        payeeSynced.current = "";
      }
    })();
  }, [status, activeId, wallets]);

  const setQuick = useCallback<Ctx["setQuick"]>(async (password) => {
    if (!unlocked.current) throw new Error("locked");
    unlocked.current = await vaultSetQuick(unlocked.current, wallets, activeId, password);
    setQuickOn(!!password);
  }, [wallets, activeId]);

  const addSecret = useCallback<Ctx["addSecret"]>(async (name, secret, password) => {
    if (!unlocked.current) {
      if (!password) throw new Error("locked");
      const r = await createVault(password, name, secret);
      unlocked.current = r.unlocked;
      setWallets(r.wallets);
      setActiveId(r.active);
      setStatus("unlocked");
      return {};
    }
    const r = await vaultAdd(unlocked.current, wallets, name, secret);
    if ("duplicate" in r) return { duplicate: r.duplicate };
    unlocked.current = r.unlocked;
    setWallets(r.wallets);
    setActiveId(r.active);
    return {};
  }, [wallets]);

  const persist = useCallback(async (list: WalletMeta[], active: string) => {
    if (!unlocked.current) throw new Error("locked");
    await saveMeta(unlocked.current, list, active);
    setWallets(list);
    setActiveId(active);
  }, []);

  const switchTo = useCallback((id: string) => persist(wallets, id), [persist, wallets]);
  const rename = useCallback((id: string, name: string) => persist(wallets.map((w) => (w.id === id ? { ...w, name } : w)), activeId), [persist, wallets, activeId]);
  const remove = useCallback(async (id: string) => {
    if (!unlocked.current) throw new Error("locked");
    const r = await vaultRemove(unlocked.current, wallets, id);
    if (!r) {
      unlocked.current = null;
      setWallets([]);
      setActiveId("");
      setStatus("empty");
      return;
    }
    unlocked.current = r.unlocked;
    setWallets(r.wallets);
    setActiveId(r.active);
  }, [wallets]);

  const setChain = useCallback((key: string) => {
    setChainKey(key);
    try {
      localStorage.setItem(CHAIN_KEY, key);
    } catch {}
  }, []);

  const value = useMemo<Ctx>(() => {
    const active = wallets.find((w) => w.id === activeId) ?? wallets[0] ?? null;
    return {
      status,
      wallets,
      active,
      chain: chainByKey(chainKey),
      setChain,
      unlock,
      lock,
      addSecret,
      switchTo,
      rename,
      remove,
      address: active ? addressOn(active, chainByKey(chainKey)) : undefined,
      account: () => {
        const s = active && unlocked.current?.plain.secrets[active.id];
        if (!s) throw new Error("locked");
        return accountOf(s);
      },
      solKeypair: () => {
        const s = active && unlocked.current?.plain.secrets[active.id];
        if (!s) throw new Error("locked");
        const kp = solKeypairOf(s);
        if (!kp) throw new Error("私钥导入的钱包没有 Solana 账户，请用助记词钱包");
        return kp;
      },
      tronKey: () => {
        const s = active && unlocked.current?.plain.secrets[active.id];
        if (!s) throw new Error("locked");
        return tronKeyOf(s);
      },
      tonKey: () => {
        const s = active && unlocked.current?.plain.secrets[active.id];
        if (!s) throw new Error("locked");
        const k = tonKeyOf(s);
        if (!k) throw new Error("私钥导入的钱包没有 TON 账户，请用助记词钱包");
        return k;
      },
      secretOf: (id) => unlocked.current?.plain.secrets[id] ?? null,
      quick: quickOn,
      setQuick,
    };
  }, [status, wallets, activeId, chainKey, setChain, unlock, lock, addSecret, switchTo, rename, remove, quickOn, setQuick]);

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useVault() {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useVault must be used within WalletProvider");
  return c;
}
