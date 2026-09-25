/** Minimal external stores for client-only state (localStorage prefs, ticking clock). */

type Listener = () => void;

function createStore<T>(read: () => T, write: (v: T) => void, serverValue: T) {
  const listeners = new Set<Listener>();
  return {
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: read,
    getServer: () => serverValue,
    set(v: T) {
      write(v);
      listeners.forEach((l) => l());
    },
  };
}

export type Theme = "arc" | "terminal";
export type Locale = "zh" | "en";

export const themeStore = createStore<Theme>(
  () => {
    const t = document.documentElement.dataset.theme;
    return t === "terminal" ? "terminal" : "arc";
  },
  (v) => {
    document.documentElement.dataset.theme = v;
    try {
      localStorage.setItem("arm.theme", v);
    } catch {}
  },
  "arc",
);

// English by default; Chinese only when the user picked it (or arrived via ?lang=zh).
export const localeStore = createStore<Locale>(
  () => {
    try {
      return localStorage.getItem("arm.locale") === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  },
  (v) => {
    // Keep <html lang> truthful: Edge / Chrome auto-translate fires when it thinks the page language differs
    // from the user's, and translation rewrites text nodes under React's feet (insertBefore NotFoundError).
    document.documentElement.lang = v === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem("arm.locale", v);
    } catch {}
  },
  "en",
);

/** One-second clock for live countdowns; only ticks while something subscribes. */
const secListeners = new Set<Listener>();
let secTimer: ReturnType<typeof setInterval> | null = null;
let secNow = 0;

export const secondClockStore = {
  subscribe(l: Listener) {
    secListeners.add(l);
    if (!secTimer) {
      secNow = Date.now();
      secTimer = setInterval(() => {
        secNow = Date.now();
        secListeners.forEach((fn) => fn());
      }, 1000);
    }
    return () => {
      secListeners.delete(l);
      if (secListeners.size === 0 && secTimer) {
        clearInterval(secTimer);
        secTimer = null;
      }
    };
  },
  get: (): number | null => (secNow ||= Date.now()),
  getServer: (): number | null => null,
};

/** Shared clock that ticks every 15s; server snapshot is null so SSR renders a placeholder. */
const clockListeners = new Set<Listener>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockNow = 0;

export const clockStore = {
  subscribe(l: Listener) {
    clockListeners.add(l);
    if (!clockTimer) {
      clockNow = Date.now();
      clockTimer = setInterval(() => {
        clockNow = Date.now();
        clockListeners.forEach((fn) => fn());
      }, 15_000);
    }
    return () => {
      clockListeners.delete(l);
      if (clockListeners.size === 0 && clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    };
  },
  get: (): number | null => (clockNow ||= Date.now()),
  getServer: (): number | null => null,
};
