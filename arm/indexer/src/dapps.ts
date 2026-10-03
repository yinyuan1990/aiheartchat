import { sql } from "./db.js";

/**
 * DApp catalogue shown on the in-App wallet's DApp page (categories → sites). Edited by the factory owner in /admin;
 * while nothing is stored the wallet uses the built-in default list (web/src/lib/wallet/dapp-catalog.ts).
 * Being listed only skips the "unknown site" notice in the wallet; it never grants any permission.
 */
export type DappItem = { name: string; url: string; desc?: string; icon?: string; chains?: string[] };
export type DappCategory = { id: string; name: string; items: DappItem[] };

const KEY = "dapp_catalog";
const CHAINS = new Set(["arc", "eth", "bsc", "base", "arb", "polygon"]);
const LIMITS = { categories: 12, items: 40, catName: 12, name: 24, desc: 60, url: 300 };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const httpsUrl = (v: unknown) => {
  const s = str(v, LIMITS.url);
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
};

/** Throws with a readable message on the first bad entry, so the admin sees what to fix. */
export function validateCatalog(input: unknown): DappCategory[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("categories must be a non-empty list");
  if (input.length > LIMITS.categories) throw new Error(`at most ${LIMITS.categories} categories`);
  const ids = new Set<string>();
  return input.map((c, ci) => {
    const id = str(c?.id, 24).toLowerCase();
    const name = str(c?.name, LIMITS.catName);
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`category ${ci + 1}: id must be a-z, 0-9 or -`);
    if (ids.has(id)) throw new Error(`category ${ci + 1}: duplicate id "${id}"`);
    ids.add(id);
    if (!name) throw new Error(`category ${ci + 1}: name is empty`);
    const items = Array.isArray(c?.items) ? c.items : [];
    if (items.length > LIMITS.items) throw new Error(`${name}: at most ${LIMITS.items} sites`);
    return {
      id,
      name,
      items: items.map((it: Record<string, unknown>, ii: number): DappItem => {
        const n = str(it?.name, LIMITS.name);
        const url = httpsUrl(it?.url);
        if (!n) throw new Error(`${name} #${ii + 1}: name is empty`);
        if (!url) throw new Error(`${name} / ${n}: url must be https://…`);
        const out: DappItem = { name: n, url };
        const desc = str(it?.desc, LIMITS.desc);
        if (desc) out.desc = desc;
        const icon = str(it?.icon, LIMITS.url);
        if (icon) {
          if (!/^ph:[a-z]+$/.test(icon) && !httpsUrl(icon)) throw new Error(`${name} / ${n}: icon must be https://… or ph:<name>`);
          out.icon = icon;
        }
        const chains = Array.isArray(it?.chains) ? [...new Set((it.chains as unknown[]).map((x) => String(x)))].filter((x) => CHAINS.has(x)) : [];
        if (chains.length) out.chains = chains;
        return out;
      }),
    };
  });
}

export async function getCatalog(): Promise<{ categories: DappCategory[] | null; updatedAt: string | null }> {
  const [row] = await sql`select value, updated_at from settings where key = ${KEY}`;
  return row ? { categories: (row.value as { categories: DappCategory[] }).categories, updatedAt: new Date(row.updated_at).toISOString() } : { categories: null, updatedAt: null };
}

export async function saveCatalog(categories: DappCategory[]) {
  await sql`insert into settings (key, value, updated_at) values (${KEY}, ${sql.json({ categories } as never)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return getCatalog();
}

export async function resetCatalog() {
  await sql`delete from settings where key = ${KEY}`;
  return getCatalog();
}
