/** In-memory ring buffer of recent keeper actions, exposed to the admin panel. Not persisted on purpose. */
export type KeeperEntry = {
  ts: string;
  action: "distribute" | "sync" | "settle" | "markGraduated" | "execute" | "buyback" | "error";
  token?: string;
  detail: string;
  hash?: string;
  ok: boolean;
};

const MAX = 200;
const entries: KeeperEntry[] = [];
let lastTick: string | null = null;

export function keeperLog(e: Omit<KeeperEntry, "ts">) {
  entries.unshift({ ts: new Date().toISOString(), ...e });
  if (entries.length > MAX) entries.length = MAX;
}

export function keeperTicked() {
  lastTick = new Date().toISOString();
}

export function keeperState() {
  return { lastTick, entries: entries.slice(0, 100) };
}
