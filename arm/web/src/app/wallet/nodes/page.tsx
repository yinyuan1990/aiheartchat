"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, CheckCircle, Circle, Lightning, Plus, ShieldWarning, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { WALLET_CHAINS, addNode, chainByKey, isCustomNode, isEvm, isSolana, isTron, nodeLabel, nodesOf, probeChainNode, removeNode, rpcOf, selectNode, useNodes, type NodeProbe, type WalletChain } from "@/lib/wallet/chains";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, ChainGlyph, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

/** How far behind the best node a node may be before it is flagged. */
const LAG_BLOCKS = 5n;

const hostPath = (url: string) => {
  if (nodeLabel(url) !== url.replace(/^https?:\/\//, "")) return nodeLabel(url);
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

const speedClass = (ms: number) => (ms < 300 ? "text-up" : ms < 1000 ? "text-[#d48806]" : "text-down");

export default function NodesPage() {
  const vault = useVault();
  const [key, setKey] = useState(vault.chain.key);
  const chain = chainByKey(key);
  useNodes();
  const list = nodesOf(chain);
  const current = rpcOf(chain);
  const [probes, setProbes] = useState<Record<string, NodeProbe | "busy">>({});
  const [adding, setAdding] = useState(false);

  const probeAll = useCallback(async (c: WalletChain) => {
    const urls = nodesOf(c);
    setProbes((p) => ({ ...p, ...Object.fromEntries(urls.map((u) => [u, "busy" as const])) }));
    await Promise.all(
      urls.map(async (u) => {
        const r = await probeChainNode(c, u);
        setProbes((p) => ({ ...p, [u]: r.chainId != null && r.chainId !== c.chain.id ? { ...r, error: isSolana(c) ? "不是 Solana 主网" : `链 ID 不对（${r.chainId}）` } : r }));
      }),
    );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void probeAll(chain), 0);
    return () => clearTimeout(t);
  }, [chain, probeAll]);

  const done = list.map((u) => [u, probes[u]] as const).filter((x): x is readonly [string, NodeProbe] => !!x[1] && x[1] !== "busy" && !x[1].error);
  const best = done.reduce<bigint>((m, [, p]) => (p.block != null && p.block > m ? p.block : m), 0n);
  // Solana slots are 0.4 s and nodes answer at different commitment depths
  const lag = isSolana(chain) ? 150n : LAG_BLOCKS;
  const lagging = (p: NodeProbe) => p.block != null && best - p.block > lag;

  const pickFastest = () => {
    const ok = done.filter(([, p]) => !lagging(p)).sort((a, b) => a[1].ms - b[1].ms)[0];
    if (!ok) return void toast.error("没有可用的节点，稍后再测");
    selectNode(chain, ok[0]);
    toast.success(`已切到 ${hostPath(ok[0])}（${ok[1].ms} ms）`);
  };

  const choose = (u: string) => {
    const p = probes[u];
    selectNode(chain, u);
    if (p && p !== "busy" && p.error) toast.warning("这个节点刚才没测通，余额和转账可能出错");
  };

  return (
    <WalletFrame>
      <TopBar title="节点" back="/wallet/me" />
      <div className="flex-1 space-y-3 px-4 pb-6">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {WALLET_CHAINS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setKey(c.key)}
              className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1.5 text-[13px] font-medium transition", c.key === key ? "bg-foreground text-background" : "bg-muted")}
            >
              <ChainGlyph chain={c} size={22} />
              {c.name}
            </button>
          ))}
        </div>

        <section className="rounded-[22px] bg-card ring-1 ring-border/60">
          <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
            <span className="text-[13px] font-medium text-muted-foreground">
              {chain.name} · {isEvm(chain) ? `链 ID ${chain.chain.id}` : "主网"}
            </span>
            <span className="flex items-center gap-1">
              <button type="button" onClick={() => void probeAll(chain)} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                <ArrowsClockwise size={13} />
                测速
              </button>
              <button type="button" onClick={pickFastest} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                <Lightning size={13} weight="fill" />
                选最快的
              </button>
            </span>
          </div>
          <ul className="divide-y divide-border/60">
            {list.map((u) => {
              const p = probes[u];
              const on = u === current;
              return (
                <li key={u} className="flex items-center gap-2">
                  <button type="button" onClick={() => choose(u)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left">
                    {on ? <CheckCircle size={20} weight="fill" className="shrink-0" /> : <Circle size={20} className="shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[13px]">{hostPath(u)}</span>
                        {isCustomNode(chain, u) && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">自定义</span>}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {!p || p === "busy" ? "测速中…" : p.error ? p.error : `${isSolana(chain) ? "Slot" : "区块"} #${p.block?.toLocaleString("en-US")}${lagging(p) ? ` · 落后 ${(best - p.block!).toString()} 块` : ""}`}
                      </span>
                    </span>
                    <span className={cn("shrink-0 font-mono text-[13px] font-semibold", !p || p === "busy" ? "text-muted-foreground" : p.error ? "text-down" : lagging(p) ? "text-[#d48806]" : speedClass(p.ms))}>
                      {!p || p === "busy" ? "…" : p.error ? "不可用" : `${p.ms} ms`}
                    </span>
                  </button>
                  {isCustomNode(chain, u) && (
                    <button type="button" aria-label="删除节点" onClick={() => removeNode(chain, u)} className="mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-down hover:bg-down/10">
                      <Trash size={16} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 border-t border-border/60 py-3.5 text-[14px] font-semibold">
            <Plus size={15} weight="bold" />
            添加自定义节点
          </button>
        </section>

        <p className="flex gap-1.5 px-2 text-[12px] leading-5 text-muted-foreground">
          <ShieldWarning size={14} className="mt-0.5 shrink-0" />
          节点只用来读链上数据和广播交易，私钥不会发给节点。来路不明的自定义节点可能显示假的余额或拖着不广播交易，只添加你信任的节点。
        </p>
      </div>

      <BottomSheet open={adding} onClose={() => setAdding(false)}>
        {adding && <AddNode chain={chain} onDone={() => setAdding(false)} onAdded={() => void probeAll(chain)} />}
      </BottomSheet>
    </WalletFrame>
  );
}

function AddNode({ chain, onDone, onAdded }: { chain: WalletChain; onDone: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const u = url.trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return setErr("网址格式不对");
    }
    if (parsed.protocol !== "https:") return setErr("只支持 https:// 开头的节点");
    setBusy(true);
    setErr(null);
    const r = await probeChainNode(chain, u, 8000);
    setBusy(false);
    if (r.error) return setErr(`连不上：${r.error}`);
    if (r.chainId !== chain.chain.id) return setErr(isSolana(chain) ? "这个节点不是 Solana 主网（genesis 不对）" : `这是链 ID ${r.chainId} 的节点，不是 ${chain.name}（${chain.chain.id}）`);
    addNode(chain, u);
    toast.success(`已添加并切换到这个节点（${r.ms} ms）`);
    onAdded();
    onDone();
  };

  return (
    <>
      <div className="text-center text-[17px] font-semibold">添加 {chain.name} 节点</div>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://"
        inputMode="url"
        autoCapitalize="none"
        spellCheck={false}
        className="mt-5 h-12 w-full rounded-2xl bg-muted px-4 font-mono text-[14px] outline-none placeholder:text-muted-foreground/70"
      />
      {err && <div className="mt-2 text-[12px] text-down">{err}</div>}
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{isSolana(chain) ? "添加前会先连一次，核对是 Solana 主网。" : isTron(chain) ? "填 TronGrid 风格的 HTTP 地址（如 https://api.trongrid.io），添加前会先连一次。" : `添加前会先连一次，核对链 ID 是 ${chain.chain.id}。`}</p>
      <div className="mt-4 grid grid-cols-[1fr_2fr] gap-2">
        <GhostButton onClick={onDone}>取消</GhostButton>
        <PrimaryButton disabled={busy || !url.trim()} onClick={submit}>
          {busy ? "连接中…" : "添加"}
        </PrimaryButton>
      </div>
    </>
  );
}
