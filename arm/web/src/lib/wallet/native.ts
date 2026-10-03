/** Optional hooks the 心之音 App shell exposes on `window.ArmWalletNative`; every call is a no-op in a plain browser. */
type MaybePromise<T> = T | Promise<T>;

export type RpcError = { code: number; message: string };
export type DappResponse = { id: number; result?: unknown; error?: RpcError };
export type DappRequest = { id: number; origin: string; method: string; params?: unknown };

/** Messages the shell pushes into the wallet page (window event `armwallet:native`). */
export type NativePush =
  | { push: "dappRequest"; req: DappRequest }
  /** The user closed the request sheet from native chrome (back key / close button): answer 4001. */
  | { push: "dappCancel" }
  /** The DApp page navigated away or the browser closed: drop everything pending for it. */
  | { push: "dappReset" }
  | { push: "dappVisited"; url: string; title?: string }
  | { push: "dappFavorite"; url: string; title?: string };

type Bridge = {
  platform?: string;
  features?: string[];
  setSecureScreen?: (on: boolean) => void;
  share?: (text: string) => void;
  toast?: (text: string) => void;
  scanQr?: () => void;
  haptic?: (kind: string) => void;
  /** Non-secret key/value storage kept outside the web origin (site permissions, DApp history). */
  storeGet?: (key: string) => MaybePromise<string | null>;
  storeSet?: (key: string, value: string | null) => MaybePromise<unknown>;
  openDapp?: (url: string) => void;
  dappReady?: () => void;
  dappRespond?: (r: DappResponse) => void;
  dappEmit?: (e: { origin: string; event: string; data: unknown }) => void;
  /** Raise (true) / lower (false) the wallet layer above the DApp page while a request sheet is up. */
  dappShow?: (on: boolean) => void;
};

/**
 * Android fallback shell (vendor WebViews without androidx.webkit) injects a raw `addJavascriptInterface` object:
 * methods only, synchronous, string/boolean arguments. It is recognised by `bridgeInfo()` and wrapped here.
 */
type SyncBridge = Record<string, ((...a: unknown[]) => unknown) | undefined> & { bridgeInfo: () => string };
let wrapped: { raw: SyncBridge; bridge: Bridge } | undefined;

function wrapSync(raw: SyncBridge): Bridge {
  if (wrapped?.raw === raw) return wrapped.bridge;
  let info: { platform?: string; features?: string[] } = {};
  try {
    info = JSON.parse(raw.bridgeInfo());
  } catch {}
  // Java bridge methods must be called on the bridge object itself
  const call = (k: string, ...a: unknown[]) => (typeof raw[k] === "function" ? raw[k]!(...a) : undefined);
  const json = (v: unknown) => JSON.stringify(v ?? null);
  const bridge: Bridge = {
    platform: info.platform,
    features: info.features ?? [],
    setSecureScreen: (on) => void call("setSecureScreen", !!on),
    share: (t) => void call("share", String(t)),
    toast: (t) => void call("toast", String(t)),
    storeGet: (k) => (call("storeGet", String(k)) as string | null | undefined) ?? null,
    storeSet: (k, v) => call("storeSet", String(k), v == null ? null : String(v)),
    openDapp: (u) => void call("openDapp", String(u)),
    dappReady: () => void call("dappReady"),
    dappRespond: (r) => void call("dappRespond", json(r)),
    dappEmit: (e) => void call("dappEmit", json(e)),
    dappShow: (on) => void call("dappShow", !!on),
  };
  wrapped = { raw, bridge };
  return bridge;
}

export const nativeBridge = (): Bridge | undefined => {
  if (typeof window === "undefined") return undefined;
  const b = (window as unknown as { ArmWalletNative?: Bridge | SyncBridge }).ArmWalletNative;
  if (!b) return undefined;
  return typeof (b as SyncBridge).bridgeInfo === "function" ? wrapSync(b as SyncBridge) : (b as Bridge);
};

export const hasFeature = (f: string) => !!nativeBridge()?.features?.includes(f);

export function onNativePush(fn: (m: NativePush) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<NativePush>).detail);
  window.addEventListener("armwallet:native", h);
  return () => window.removeEventListener("armwallet:native", h);
}

/** Blocks screenshots / screen recording (Android FLAG_SECURE, iOS overlay) while secrets are on screen. */
export const setSecureScreen = (on: boolean) => nativeBridge()?.setSecureScreen?.(on);

export async function shareText(text: string): Promise<boolean> {
  const b = nativeBridge();
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
