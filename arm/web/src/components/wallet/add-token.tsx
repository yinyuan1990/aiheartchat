"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, CircleNotch, ClipboardText, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { useTokens } from "@/lib/api";
import { isTon, isTron, type WalletChain } from "@/lib/wallet/chains";
import { isTronAddress, trc20Meta } from "@/lib/wallet/tron";
import { isTonAddress, tonJettonMeta } from "@/lib/wallet/ton";
import { forgetToken, isMarketChain, rememberToken, useHeldTokens, useMarketList, type MarketChainKey } from "@/lib/wallet/market";
import { lookupToken } from "@/lib/wallet/swap";
import { absUrl, tokenIcon } from "@/lib/wallet/assets";
import { COMMON_TOKENS } from "@/lib/wallet/common-tokens";
import { t } from "@/lib/wallet/i18n";
import { BottomSheet, ChainGlyph } from "./ui";

type Candidate = { address: string; symbol: string; name: string; image?: string | null };

/** Wrapped tokens whose contract kept an older symbol */
const SYMBOL_ALIASES: Record<string, string[]> = { WPOL: ["WMATIC"] };
const symbolOk = (want: string, got: string) => {
  const w = want.toUpperCase();
  const g = got.toUpperCase();
  return w === g || (SYMBOL_ALIASES[w] ?? []).includes(g);
};

/**
 * 添加代币: search by name / symbol / contract, or tap one of the chain's common and hot tokens. Every add reads the
 * token from the chain first (symbol must match the list's) so the asset list only ever shows real contracts.
 * `known`: contracts already on the asset list (lower-case), shown as added.
 */
export function AddTokenSheet({ chain, open, onClose, known = [] }: { chain: WalletChain; open: boolean; onClose: () => void; known?: string[] }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);
  const tron = isTron(chain);
  const ton = isTon(chain);
  const isAddr = tron ? isTronAddress(q) : ton ? isTonAddress(q) : /^0x[0-9a-fA-F]{40}$/.test(q);
  const look = (a: string) => (tron ? (isTronAddress(a) ? trc20Meta(a).then((m) => m && { address: a, ...m }) : Promise.resolve(null)) : ton ? tonJettonMeta(a) : lookupToken(chain, a));
  const found = useQuery({ queryKey: ["wallet", "add-token", chain.key, q], enabled: open && isAddr, queryFn: () => look(q), staleTime: 300_000, retry: 1 });
  const mine = useHeldTokens(chain.key).filter((t) => t.added);
  const have = new Set([...known.map((k) => k.toLowerCase()), ...mine.map((m) => m.address.toLowerCase())]);
  const [busy, setBusy] = useState<string | null>(null);

  const add = async (c: Candidate, verify: boolean) => {
    setBusy(c.address);
    try {
      const tk = await look(c.address);
      if (!tk) throw new Error(t("cw.addToken.notToken", { chain: chain.name }));
      if (verify && !symbolOk(c.symbol, tk.symbol)) throw new Error(t("cw.addToken.symbolMismatch", { got: tk.symbol, want: c.symbol }));
      rememberToken(chain.key, { address: tk.address, symbol: tk.symbol, name: tk.name, image: c.image ?? ("image" in tk ? (tk.image as string | null) : null), decimals: tk.decimals, added: true });
      toast.success(t("cw.addToken.added", { sym: tk.symbol }));
      if (!verify) setInput("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const paste = async () => {
    try {
      setInput((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error(t("cw.addToken.clipboardFailed"));
    }
  };
  const match = (c: Candidate) => !q || isAddr || [c.symbol, c.name].some((s) => s.toLowerCase().includes(q.toLowerCase()));
  const common = (COMMON_TOKENS[chain.key] ?? []).filter(match);
  const hit = found.data;

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-3 flex items-center justify-center gap-1.5 text-[17px] font-semibold">
        {t("cw.addToken.title")}
        <span className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-2 pl-0.5 text-[12px] font-medium text-muted-foreground">
          <ChainGlyph chain={chain} size={16} />
          {chain.name}
        </span>
      </div>
      <label className="flex h-12 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="shrink-0 text-muted-foreground" />
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("cw.addToken.searchPh", { hint: tron ? "T…" : ton ? "EQ…" : "0x…" })} autoCapitalize="none" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
        <button type="button" onClick={paste} aria-label={t("cw.addToken.paste")} className="shrink-0 text-muted-foreground">
          <ClipboardText size={18} />
        </button>
      </label>

      <div className="no-scrollbar mt-2 max-h-[58vh] overflow-y-auto">
        {isAddr ? (
          <Section title={t("cw.addToken.byAddress")}>
            {found.isFetching ? (
              <div className="h-14 animate-pulse rounded-2xl bg-muted" />
            ) : hit ? (
              <Row c={{ address: hit.address, symbol: hit.symbol, name: t("cw.addToken.nameDecimals", { name: hit.name, n: hit.decimals }) }} chain={chain.key} added={have.has(hit.address.toLowerCase())} busy={busy === hit.address} onAdd={() => void add(hit, false)} />
            ) : (
              <p className="px-1 py-2 text-[12px] text-down">{t("cw.addToken.notToken", { chain: chain.name })}</p>
            )}
            <p className="px-1 pt-1 text-[11px] leading-5 text-muted-foreground">{t("cw.addToken.scamWarn")}</p>
          </Section>
        ) : (
          <>
            {common.length > 0 && (
              <Section title={t("cw.addToken.common")}>
                {common.map((c) => (
                  <Row key={c.address} c={c} chain={chain.key} added={have.has(c.address.toLowerCase())} busy={busy === c.address} onAdd={() => void add(c, true)} />
                ))}
              </Section>
            )}
            {isMarketChain(chain.key) && <HotTokens chain={chain.key} q={q} have={have} busy={busy} onAdd={(c) => void add(c, true)} />}
            {chain.key === "arc" && <ArmTokens q={q} have={have} busy={busy} onAdd={(c) => void add(c, true)} />}
          </>
        )}

        {mine.length > 0 && !q && (
          <Section title={t("cw.addToken.manual")}>
            {mine.map((m) => (
              <li key={m.address} className="flex items-center gap-3 py-2.5">
                <TokenAvatar symbol={m.symbol} seed={m.address} logo={tokenIcon(chain.key, m.address, m.image)} size={32} className="rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{m.symbol}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{shortAddr(m.address, 6, 4)}</span>
                </span>
                <button type="button" aria-label={t("cw.addToken.remove", { sym: m.symbol })} onClick={() => forgetToken(chain.key, m.address)} className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition active:scale-90 hover:bg-muted">
                  <Trash size={17} />
                </button>
              </li>
            ))}
          </Section>
        )}
      </div>
    </BottomSheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3">
      <div className="px-1 pb-1 text-[12px] font-medium text-muted-foreground">{title}</div>
      <ul className="divide-y divide-border/50">{children}</ul>
    </section>
  );
}

function Row({ c, chain = "", added, busy, onAdd }: { c: Candidate; chain?: string; added: boolean; busy: boolean; onAdd: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <TokenAvatar symbol={c.symbol} seed={c.address} logo={tokenIcon(chain, c.address, c.image)} size={36} className="rounded-full" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{c.symbol}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{c.name}</span>
      </span>
      {added ? (
        <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
          <CheckCircle size={16} weight="fill" className="text-up" />
          {t("bot.added")}
        </span>
      ) : (
        <button type="button" disabled={busy} onClick={onAdd} aria-label={t("cw.addToken.addSym", { sym: c.symbol })} className="flex h-8 items-center gap-1 rounded-full bg-foreground px-3 text-[12px] font-semibold text-background transition active:scale-95 disabled:opacity-60">
          {busy ? <CircleNotch size={14} className="animate-spin" /> : <Plus size={14} weight="bold" />}
          {t("bot.add")}
        </button>
      )}
    </li>
  );
}

type ListProps = { q: string; have: Set<string>; busy: string | null; onAdd: (c: Candidate) => void };

function HotTokens({ chain, ...p }: ListProps & { chain: MarketChainKey }) {
  const r = useMarketList(chain, "hot", p.q);
  const rows = (r.data ?? []).slice(0, 15);
  if (r.isLoading) return <div className="mt-3 h-14 animate-pulse rounded-2xl bg-muted" />;
  if (!rows.length) return null;
  return (
    <Section title={p.q ? t("cw.addToken.results") : t("cw.coin.hot")}>
      {rows.map((m) => (
        <Row key={m.address} c={{ address: m.address, symbol: m.symbol, name: m.name, image: m.image }} chain={chain} added={p.have.has(m.address.toLowerCase())} busy={p.busy === m.address} onAdd={() => p.onAdd({ address: m.address, symbol: m.symbol, name: m.name, image: m.image })} />
      ))}
    </Section>
  );
}

function ArmTokens(p: ListProps) {
  const r = useTokens("volume", "all", "24h", 30);
  const rows = (r.data ?? []).filter((x) => !p.q || [x.symbol, x.name].some((s) => s.toLowerCase().includes(p.q.toLowerCase()))).slice(0, 15);
  if (!rows.length) return null;
  return (
    <Section title={t("cw.addToken.armTokens")}>
      {rows.map((x) => {
        const c = { address: x.address, symbol: x.symbol, name: x.name, image: absUrl(x.logo) };
        return <Row key={x.address} c={c} added={p.have.has(x.address.toLowerCase())} busy={p.busy === x.address} onAdd={() => p.onAdd(c)} />;
      })}
    </Section>
  );
}
