"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DeviceMobile } from "@phosphor-icons/react";
import { WalletProvider, useVault } from "@/components/wallet/wallet-context";
import { UnlockScreen } from "@/components/wallet/unlock";
import { WalletFrame } from "@/components/wallet/ui";

const ONBOARDING = ["/wallet/welcome", "/wallet/create", "/wallet/import"];
const PREVIEW = ["/wallet/sign"];

const noSubscribe = () => () => {};
/** The wallet is only offered inside the 心之音 App (its shell injects the native bridge); localhost stays open for dev / e2e. */
function useWalletHost(): "loading" | "ok" | "outside" {
  return useSyncExternalStore(
    noSubscribe,
    () => ((window as unknown as { ArmWalletNative?: unknown }).ArmWalletNative || /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "ok" : "outside"),
    () => "loading",
  );
}

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  const host = useWalletHost();
  if (host === "loading") return <WalletFrame>{null}</WalletFrame>;
  if (host === "outside") return <OutsideApp />;
  return (
    <WalletProvider>
      <Gate>{children}</Gate>
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
  const preview = PREVIEW.includes(pathname);

  useEffect(() => {
    if (status === "empty" && !onboarding && !preview) router.replace("/wallet/welcome");
    if ((status === "locked" || status === "unlocked") && pathname === "/wallet/welcome") router.replace("/wallet");
  }, [status, onboarding, preview, pathname, router]);

  if (preview) return children;
  if (status === "loading" || (status === "empty" && !onboarding)) return <WalletFrame>{null}</WalletFrame>;
  // creating / importing an extra wallet re-uses the vault password, so it needs the vault open too
  if (status === "locked") return <UnlockScreen />;
  return children;
}
