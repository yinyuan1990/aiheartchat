"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardText, MagnifyingGlass, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import type { WalletChain } from "@/lib/wallet/chains";
import { forgetToken, rememberToken, useHeldTokens } from "@/lib/wallet/market";
import { lookupToken } from "@/lib/wallet/swap";
import { iconUrl } from "@/lib/wallet/assets";
import { BottomSheet, ChainGlyph, PrimaryButton } from "./ui";

/** Add an ERC-20 to the asset list by contract address (EVM chains; Solana lists every token it finds by itself). */
export function AddTokenSheet({ chain, open, onClose }: { chain: WalletChain; open: boolean; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [addr, setAddr] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setAddr(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr);
  const found = useQuery({ queryKey: ["wallet", "add-token", chain.key, addr.toLowerCase()], enabled: open && valid, queryFn: () => lookupToken(chain, addr), staleTime: 300_000, retry: 1 });
  const mine = useHeldTokens(chain.key).filter((t) => t.added);
  const t = found.data;
  const already = !!t && mine.some((m) => m.address.toLowerCase() === t.address.toLowerCase());

  const paste = async () => {
    try {
      setInput((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error("没读到剪贴板，请手动粘贴");
    }
  };
  const add = () => {
    if (!t) return;
    rememberToken(chain.key, { address: t.address, symbol: t.symbol, name: t.name, image: null, decimals: t.decimals, added: true });
    toast.success(`已添加 ${t.symbol}`);
    setInput("");
    onClose();
  };

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-3 flex items-center justify-center gap-1.5 text-[17px] font-semibold">
        添加代币
        <span className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-2 pl-0.5 text-[12px] font-medium text-muted-foreground">
          <ChainGlyph chain={chain} size={16} />
          {chain.name}
        </span>
      </div>
      <label className="flex h-12 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="shrink-0 text-muted-foreground" />
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="代币合约地址 0x…" autoCapitalize="none" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
        <button type="button" onClick={paste} aria-label="粘贴" className="shrink-0 text-muted-foreground">
          <ClipboardText size={18} />
        </button>
      </label>

      <div className="mt-3 min-h-[76px]">
        {!addr ? (
          <p className="px-1 text-[12px] leading-5 text-muted-foreground">在区块浏览器或项目官网复制代币的合约地址。只添加你确认过的代币，仿冒币常用一模一样的名字。</p>
        ) : !valid ? (
          <p className="px-1 text-[12px] text-down">地址格式不对</p>
        ) : found.isFetching ? (
          <div className="h-16 animate-pulse rounded-2xl bg-muted" />
        ) : t ? (
          <div className="flex items-center gap-3 rounded-2xl bg-muted/60 px-3.5 py-3">
            <TokenAvatar symbol={t.symbol} seed={t.seed} logo={iconUrl(t.logo)} size={40} className="rounded-full" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{t.symbol}</span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {t.name} · 精度 {t.decimals}
              </span>
            </span>
          </div>
        ) : (
          <p className="px-1 text-[12px] text-down">{chain.name} 上这个地址不是代币合约</p>
        )}
      </div>

      <PrimaryButton className="mt-3" disabled={!t || already} onClick={add}>
        {already ? "已经添加过了" : "添加"}
      </PrimaryButton>

      {mine.length > 0 && (
        <div className="mt-5">
          <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">手动添加的代币</div>
          <ul className="divide-y divide-border/50">
            {mine.map((m) => (
              <li key={m.address} className="flex items-center gap-3 py-2.5">
                <TokenAvatar symbol={m.symbol} seed={m.address} logo={iconUrl(m.image)} size={32} className="rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{m.symbol}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{shortAddr(m.address, 6, 4)}</span>
                </span>
                <button type="button" aria-label={`移除 ${m.symbol}`} onClick={() => forgetToken(chain.key, m.address)} className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition active:scale-90 hover:bg-muted">
                  <Trash size={17} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </BottomSheet>
  );
}
