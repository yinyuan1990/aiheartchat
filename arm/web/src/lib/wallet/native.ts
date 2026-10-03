/** Optional hooks the 心之音 App shell exposes on `window.ArmWalletNative`; every call is a no-op in a plain browser. */
type Bridge = {
  setSecureScreen?: (on: boolean) => void;
  share?: (text: string) => void;
  scanQr?: () => void;
  haptic?: (kind: string) => void;
};

const bridge = (): Bridge | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { ArmWalletNative?: Bridge }).ArmWalletNative);

/** Blocks screenshots / screen recording (Android FLAG_SECURE, iOS overlay) while secrets are on screen. */
export const setSecureScreen = (on: boolean) => bridge()?.setSecureScreen?.(on);

export async function shareText(text: string): Promise<boolean> {
  const b = bridge();
  if (b?.share) {
    b.share(text);
    return true;
  }
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ text });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
