"use client";

import { useState, useSyncExternalStore } from "react";
import { ArrowRight, CaretRight, ClockCounterClockwise, Compass, GameController, Globe, LinkBreak, RocketLaunch, SealCheck, Star, Trophy, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { chainById } from "@/lib/wallet/chains";
import { hasFeature, nativeBridge } from "@/lib/wallet/native";
import { ackOrigin, clearRecents, hostOf, isAcked, isTrusted, originOf, revokePerm, useDappStore } from "@/lib/wallet/dapp-store";
import { BottomNav, BottomSheet, ChainGlyph, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const ARM_SITE = "https://arm.yyheart.com";
const ARM = [
  { path: "/", title: "Arm 首页", sub: "免费发币 · 78% 手续费归创作者", icon: Compass },
  { path: "/create", title: "发币", sub: "几分钟发一个 Arc 代币", icon: RocketLaunch },
  { path: "/games", title: "游戏探索", sub: "快艇冲冲冲 · 卖在山顶", icon: GameController },
  { path: "/rank", title: "排行榜", sub: "看看谁在赚钱", icon: Trophy },
];

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

  const launch = (url: string) => {
    const b = nativeBridge();
    if (b?.openDapp) b.openDapp(url);
    else window.open(url, "_blank", "noopener");
  };
  const open = (url: string) => {
    const origin = originOf(url);
    if (!origin) return toast.error("网址格式不对");
    if (isTrusted(origin) || isAcked(origin)) return launch(url);
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

        <Section title="Arm">
          <ul className="divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
            {ARM.map((a) => (
              <li key={a.path}>
                <button type="button" onClick={() => open(`${ARM_SITE}${a.path}`)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                    <a.icon size={20} weight="duotone" />
                  </span>
                  <span className="flex-1">
                    <span className="flex items-center gap-1 text-[15px] font-semibold">
                      {a.title}
                      <SealCheck size={14} weight="fill" className="text-up" />
                    </span>
                    <span className="block text-[12px] text-muted-foreground">{a.sub}</span>
                  </span>
                  <CaretRight size={16} className="text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </Section>

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

function Favicon({ origin }: { origin: string }) {
  const [ok, setOk] = useState(true);
  return ok ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`${origin}/favicon.ico`} alt="" onError={() => setOk(false)} className="size-9 shrink-0 rounded-xl bg-muted object-cover" />
  ) : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
      <Globe size={18} weight="duotone" />
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
