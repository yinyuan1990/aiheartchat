"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRight, CaretRight, ClockCounterClockwise, Compass, GameController, Globe, LinkBreak, RocketLaunch, SealCheck, Star, Trophy, Warning, type Icon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WALLET_CHAINS, chainById, chainByKey } from "@/lib/wallet/chains";
import { hasFeature, nativeBridge } from "@/lib/wallet/native";
import { ackOrigin, clearRecents, hostOf, isAcked, isTrusted, originOf, revokePerm, setLaunchChain, useDappStore } from "@/lib/wallet/dapp-store";
import { catalogFor, isListed, useDappCatalog, type DappItem } from "@/lib/wallet/dapp-catalog";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomNav, BottomSheet, ChainGlyph, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

/** `icon: "ph:<key>"` in the catalogue → a built-in icon instead of the site's favicon. */
const PH_ICONS: Record<string, Icon> = { compass: Compass, rocket: RocketLaunch, game: GameController, trophy: Trophy, star: Star, globe: Globe };

/** Typed text → https URL, or null when it does not look like an address. */
function toUrl(input: string): string | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}

const noSubscribe = () => () => {};

export default function DappPage() {
  const store = useDappStore();
  const supported = useSyncExternalStore(noSubscribe, () => hasFeature("dapp"), () => true);
  const [input, setInput] = useState("");
  const [risky, setRisky] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);

  const launch = (url: string, chainId?: number) => {
    const origin = originOf(url);
    if (origin && chainId) setLaunchChain(origin, chainId);
    const b = nativeBridge();
    if (b?.openDapp) b.openDapp(url);
    else window.open(url, "_blank", "noopener");
  };
  const open = (url: string, chainId?: number) => {
    const origin = originOf(url);
    if (!origin) return toast.error("网址格式不对");
    if (isTrusted(origin) || isAcked(origin) || isListed(origin)) return launch(url, chainId);
    setRemember(true);
    setRisky(url);
  };
  const submit = () => {
    const url = toUrl(input);
    if (!url) return toast.error("请输入网址，例如 arm.yyheart.com");
    open(url);
  };
  const perms = Object.entries(store.perms).sort((a, b) => b[1].at - a[1].at);

  return (
    <WalletFrame>
      <TopBar title="DApp" />
      <div className="flex-1 space-y-5 px-4 pb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex h-12 items-center gap-2 rounded-2xl bg-card pr-1.5 pl-4 ring-1 ring-border/60 focus-within:ring-foreground"
        >
          <Globe size={18} className="shrink-0 text-muted-foreground" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="输入 DApp 网址"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/70"
          />
          <button type="submit" aria-label="打开" disabled={!input.trim()} className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground transition active:scale-90 disabled:opacity-30">
            <ArrowRight size={18} weight="bold" />
          </button>
        </form>

        {!supported && (
          <p className="flex items-start gap-1.5 rounded-2xl bg-[#d48806]/10 px-3.5 py-2.5 text-[12px] leading-5 text-[#b07005]">
            <Warning size={14} className="mt-0.5 shrink-0" />
            当前 App 版本还没有 DApp 浏览器，网页里连接钱包不会生效。请更新心之音 App。
          </p>
        )}

        {store.favs.length > 0 && (
          <Section title="收藏" icon={<Star size={14} weight="fill" />}>
            <SiteList items={store.favs} onOpen={open} />
          </Section>
        )}

        <Discover onOpen={open} />

        {store.recents.length > 0 && (
          <Section
            title="最近浏览"
            icon={<ClockCounterClockwise size={14} />}
            right={
              <button type="button" onClick={clearRecents} className="text-[12px] text-muted-foreground">
                清空
              </button>
            }
          >
            <SiteList items={store.recents.slice(0, 8)} onOpen={open} />
          </Section>
        )}

        {perms.length > 0 && (
          <Section title="已连接的网站">
            <ul className="divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
              {perms.map(([origin, p]) => {
                const c = chainById(p.chainId);
                return (
                  <li key={origin} className="flex items-center gap-3 px-4 py-3">
                    <Favicon origin={origin} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold">{hostOf(origin)}</span>
                      <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
                        <WalletDot address={p.address} size={12} />
                        <span className="font-mono">{shortAddr(p.address, 4, 4)}</span>
                        {c && (
                          <>
                            <span>·</span>
                            <ChainGlyph chain={c} size={12} />
                            {c.name}
                          </>
                        )}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        revokePerm(origin);
                        toast.success(`已断开 ${hostOf(origin)}`);
                      }}
                      className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium transition active:scale-95"
                    >
                      <LinkBreak size={13} />
                      断开
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
      </div>
      <BottomNav />

      <BottomSheet open={!!risky} onClose={() => setRisky(null)}>
        {risky && (
          <>
            <div className="flex flex-col items-center text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-[#d48806]/12 text-[#d48806]">
                <Warning size={28} weight="fill" />
              </span>
              <div className="mt-3 text-[18px] font-semibold">即将打开第三方网站</div>
              <div className="mt-1 max-w-full truncate font-mono text-[13px] text-muted-foreground">{hostOf(risky)}</div>
            </div>
            <ul className="mt-4 space-y-2 rounded-2xl bg-muted/60 px-4 py-3 text-[13px] leading-5">
              <li>· 这个网站不在推荐列表里，心之音没有审核过它。</li>
              <li>· 钓鱼网站常仿冒知名项目，骗你签名或「授权」后转走资产。</li>
              <li>· 任何让你输入助记词、私钥的网页都是骗子。</li>
              {risky.startsWith("http:") && <li className="text-down">· 这是不加密的 http 网址，内容可能被篡改。</li>}
            </ul>
            <label className="mt-3 flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4" />
              以后打开这个网站不再提示
            </label>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <GhostButton onClick={() => setRisky(null)}>取消</GhostButton>
              <PrimaryButton
                onClick={() => {
                  const origin = originOf(risky);
                  if (remember && origin) ackOrigin(origin);
                  launch(risky);
                  setRisky(null);
                }}
              >
                继续访问
              </PrimaryButton>
            </div>
          </>
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

/** Recommended DApps: chain row (defaults to the wallet's current chain) → category tabs → sites on that chain. */
function Discover({ onOpen }: { onOpen: (url: string, chainId?: number) => void }) {
  const { chain } = useVault();
  const catalog = useDappCatalog();
  const [chainKey, setChainKey] = useState<string | null>(null);
  const [catId, setCatId] = useState<string | null>(null);
  const key = chainKey ?? chain.key;
  const cats = useMemo(() => catalogFor(catalog, key), [catalog, key]);
  const cat = cats.find((c) => c.id === catId) ?? cats[0];
  const target = chainByKey(key);

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-1 px-1 text-[13px] font-medium text-muted-foreground">
        <Compass size={14} />
        常用 DApp
      </div>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {WALLET_CHAINS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setChainKey(c.key)}
            className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1 text-[13px] font-medium transition", c.key === key ? "bg-foreground text-background" : "bg-card ring-1 ring-border/60")}
          >
            <ChainGlyph chain={c} size={22} />
            {c.name}
          </button>
        ))}
      </div>
      {cats.length === 0 ? (
        <div className="rounded-[22px] bg-card px-4 py-8 text-center text-[13px] text-muted-foreground ring-1 ring-border/60">{target.name} 暂时没有推荐的 DApp，可以在上面输入网址打开</div>
      ) : (
        <div className="rounded-[22px] bg-card ring-1 ring-border/60">
          <div className="no-scrollbar flex gap-5 overflow-x-auto border-b border-border/60 px-4">
            {cats.map((c) => (
              <button key={c.id} type="button" onClick={() => setCatId(c.id)} className={cn("relative shrink-0 py-3 text-[14px] transition", c.id === cat?.id ? "font-semibold" : "text-muted-foreground")}>
                {c.name}
                {c.id === cat?.id && <span className="absolute inset-x-0 bottom-0 mx-auto h-[3px] w-5 rounded-full bg-foreground" />}
              </button>
            ))}
          </div>
          <ul className="divide-y divide-border/60">
            {cat?.items.map((it) => (
              <li key={it.url}>
                <button type="button" onClick={() => onOpen(it.url, target.chain.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                  <DappIcon item={it} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-[15px] font-semibold">
                      <span className="truncate">{it.name}</span>
                      {isTrusted(originOf(it.url) ?? "") && <SealCheck size={14} weight="fill" className="shrink-0 text-up" />}
                    </span>
                    {it.desc && <span className="block truncate text-[12px] text-muted-foreground">{it.desc}</span>}
                  </span>
                  <CaretRight size={16} className="shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DappIcon({ item }: { item: DappItem }) {
  const [ok, setOk] = useState(true);
  const Ph = item.icon?.startsWith("ph:") ? PH_ICONS[item.icon.slice(3)] : undefined;
  if (item.icon?.startsWith("ph:"))
    return (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
        {Ph ? <Ph size={20} weight="duotone" /> : <Globe size={20} weight="duotone" />}
      </span>
    );
  if (item.icon && ok)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={item.icon} alt="" onError={() => setOk(false)} className="size-10 shrink-0 rounded-xl bg-muted object-cover" />
    );
  return <Favicon origin={originOf(item.url) ?? item.url} size={40} />;
}

function Section({ title, icon, right, children }: { title: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
          {icon}
          {title}
        </span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Favicon({ origin, size = 36 }: { origin: string; size?: number }) {
  const [ok, setOk] = useState(true);
  return ok ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`${origin}/favicon.ico`} alt="" onError={() => setOk(false)} style={{ width: size, height: size }} className="shrink-0 rounded-xl bg-muted object-cover" />
  ) : (
    <span style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-xl bg-muted">
      <Globe size={size / 2} weight="duotone" />
    </span>
  );
}

function SiteList({ items, onOpen }: { items: { url: string; title?: string }[]; onOpen: (url: string) => void }) {
  return (
    <ul className="divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
      {items.map((s) => {
        const origin = originOf(s.url) ?? s.url;
        return (
          <li key={s.url}>
            <button type="button" onClick={() => onOpen(s.url)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
              <Favicon origin={origin} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold">{s.title || hostOf(origin)}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{s.url.replace(/^https:\/\//, "")}</span>
              </span>
              {isTrusted(origin) && <SealCheck size={14} weight="fill" className="shrink-0 text-up" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
