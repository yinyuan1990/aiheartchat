"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { WagmiProvider, useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { toast } from "sonner";
import { type DictKey, translate } from "@/lib/i18n";
import { localeStore, themeStore, type Locale, type Theme } from "@/lib/store";
import { wagmiConfig, chain, NET } from "@/lib/web3";
import { API_BASE } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type { Theme, Locale };

type Ctx = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: DictKey) => string;
  connected: boolean;
  address?: `0x${string}`;
  wrongChain: boolean;
  toggleConnect: () => void;
};

const AppCtx = createContext<Ctx | null>(null);

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <Inner>{children}</Inner>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Inner({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.getServer);
  const locale = useSyncExternalStore(localeStore.subscribe, localeStore.get, localeStore.getServer);
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const [pickerOpen, setPickerOpen] = useState(false);
  const t = useCallback((k: DictKey) => translate(k, locale), [locale]);

  useLiveUpdates();

  const wrongChain = isConnected && chainId !== chain.id;

  // Hide the generic "Injected" entry when EIP-6963 wallets were discovered.
  const visibleConnectors = useMemo(() => {
    const discovered = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
    return connectors.filter((c) => !(c.id === "injected" && discovered.length > 0));
  }, [connectors]);

  const connectWith = useCallback(
    async (c: Connector) => {
      try {
        await connectAsync({ connector: c, chainId: chain.id });
        setPickerOpen(false);
      } catch (e) {
        const msg = (e as Error).message;
        toast.error(/provider|not found|No injected/i.test(msg) ? t("wallet.notFound") : msg.split("\n")[0]);
      }
    },
    [connectAsync, t],
  );

  const value = useMemo<Ctx>(
    () => ({
      theme,
      setTheme: themeStore.set,
      locale,
      setLocale: localeStore.set,
      t,
      connected: isConnected,
      address,
      wrongChain,
      toggleConnect: async () => {
        if (isConnected) {
          if (wrongChain) {
            try {
              await switchChainAsync({ chainId: chain.id });
            } catch (e) {
              toast.error((e as Error).message.split("\n")[0]);
            }
            return;
          }
          disconnect();
          return;
        }
        // e2e / single-wallet environments: connect straight away
        const injectedOnly = visibleConnectors.filter((c) => c.type === "injected");
        if (visibleConnectors.length === 1 || (injectedOnly.length === 1 && visibleConnectors.length <= 2 && typeof window !== "undefined" && (window as unknown as { ethereum?: { _e2e?: boolean } }).ethereum?._e2e)) {
          void connectWith(injectedOnly[0] ?? visibleConnectors[0]);
          return;
        }
        setPickerOpen(true);
      },
    }),
    [theme, locale, t, isConnected, address, wrongChain, disconnect, switchChainAsync, visibleConnectors, connectWith],
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("wallet.choose")}</DialogTitle>
            <DialogDescription>Arc {t(`common.net.${NET}`)} · {t("common.usdcSettled")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {visibleConnectors.length === 0 && <p className="text-sm text-muted-foreground">{t("wallet.noConnectors")}</p>}
            {visibleConnectors.map((c) => (
              <Button key={c.uid} variant="outline" size="lg" className="h-12 justify-start gap-3" onClick={() => connectWith(c)}>
                {c.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon} alt="" className="size-6 rounded-md" />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-md bg-primary/15 font-mono text-[10px] text-primary">{c.name.slice(0, 2).toUpperCase()}</span>
                )}
                <span className="font-medium">{c.name}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{c.type}</span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </AppCtx.Provider>
  );
}

/** WebSocket → react-query invalidation, so lists/charts update the moment the indexer sees a block. */
function useLiveUpdates() {
  const qc = useQueryClient();
  const retry = useRef(1000);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const url = API_BASE.startsWith("http") ? API_BASE.replace(/^http/, "ws").replace(/\/api$/, "/ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }
      ws.onopen = () => (retry.current = 1000);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type: string; data?: { token?: string } };
          const token = msg.data?.token;
          const inv = (key: unknown[]) => void qc.invalidateQueries({ queryKey: key });
          switch (msg.type) {
            case "trade":
              inv(["tokens"]); inv(["activity"]); inv(["stats"]);
              if (token) { inv(["token", token]); inv(["trades", token]); inv(["candles", token]); inv(["holders", token]); }
              break;
            case "launch": inv(["tokens"]); inv(["activity"]); inv(["stats"]); break;
            case "fees": inv(["creator"]); inv(["treasury"]); inv(["stats"]); if (token) inv(["token", token]); break;
            case "graduated": inv(["tokens"]); if (token) inv(["token", token]); break;
            case "settlement": inv(["treasury"]); inv(["stats"]); inv(["admin", "overview"]); break;
          }
        } catch {}
      };
      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, retry.current);
        retry.current = Math.min(retry.current * 2, 30_000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [qc]);
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used within AppProviders");
  return ctx;
}
