"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DeviceMobile } from "@phosphor-icons/react";
import { WalletProvider, useVault } from "@/components/wallet/wallet-context";
import { UnlockScreen } from "@/components/wallet/unlock";
import { WalletFrame } from "@/components/wallet/ui";
import { DappApprover } from "@/components/wallet/dapp-approver";

const ONBOARDING = ["/wallet/welcome", "/wallet/create", "/wallet/import"];

const noSubscribe = () => () => {};
/** The wallet is only offered inside the 心之音 App (its shell injects the native bridge); localhost stays open for dev / e2e. */
function useWalletHost(): "loading" | "ok" | "outside" {
  return useSyncExternalStore(
    noSubscribe,
    () => ((window as unknown as { ArmWalletNative?: unknown }).ArmWalletNative || /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "ok" : "outside"),
    () => "loading",
  );
}

export default function WalletShell({ children }: { children: React.ReactNode }) {
  const host = useWalletHost();
  // While a DApp request sheet is up the shell lays this (transparent) WebView over the DApp page: hide the wallet
  // page itself so the site stays visible behind the sheet.
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("wallet-overlay", overlay);
  }, [overlay]);

  if (host === "loading") return <WalletFrame>{null}</WalletFrame>;
  if (host === "outside") return <OutsideApp />;
  return (
    <WalletProvider>
      <div className={overlay ? "invisible" : undefined}>
        <Gate>{children}</Gate>
      </div>
      <DappApprover onOverlay={setOverlay} />
    </WalletProvider>
  );
}

function OutsideApp() {
  return (
    <WalletFrame>
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <span className="flex size-16 items-center justify-center rounded-3xl bg-muted">
          <DeviceMobile size={32} weight="duotone" />
        </span>
        <h1 className="mt-5 text-[20px] font-semibold">请在心之音 App 里打开</h1>
        <p className="mt-2 text-[14px] leading-6 text-muted-foreground">钱包目前只在心之音 App 内提供。</p>
      </div>
    </WalletFrame>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { status } = useVault();
  const pathname = usePathname();
  const router = useRouter();
  const onboarding = ONBOARDING.includes(pathname);

  useEffect(() => {
    if (status === "empty" && !onboarding) router.replace("/wallet/welcome");
    if ((status === "locked" || status === "unlocked") && pathname === "/wallet/welcome") router.replace("/wallet");
  }, [status, onboarding, pathname, router]);

  if (status === "loading" || (status === "empty" && !onboarding)) return <WalletFrame>{null}</WalletFrame>;
  // creating / importing an extra wallet re-uses the vault password, so it needs the vault open too
  if (status === "locked") return <UnlockScreen />;
  return children;
}
