import { useEffect, useState } from 'react';
import { api } from './api';

/** 一张贴纸（聊天消息 type=sticker 的 content、评论的 sticker 字段都是这个 JSON） */
export interface StickerPayload {
  id: string;
  /** webp=静态图；lottie=Lottie JSON；awebp=动态 WebP */
  format: 'webp' | 'lottie' | 'awebp';
  url: string;
  thumb: string;
  w: number;
  h: number;
  emoji: string;
}

export interface StickerSet {
  id: number;
  title: string;
  kind: 'static' | 'animated' | 'video';
  thumb: string;
  items: StickerPayload[];
}

const CACHE_KEY = 'pw_stickers_v1';
const RECENT_KEY = 'pw_sticker_recent';
const RECENT_MAX = 24;

let memo: { version: number; sets: StickerSet[] } | null = null;
let loading: Promise<StickerSet[]> | null = null;
const listeners = new Set<() => void>();

function readCache(): { version: number; sets: StickerSet[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && Array.isArray(o.sets) ? o : null;
  } catch {
    return null;
  }
}

/** 拉全部表情包：本地有缓存就先用缓存，再按 version 问后端有没有变 */
export function loadStickers(force = false): Promise<StickerSet[]> {
  if (memo && !force) return Promise.resolve(memo.sets);
  if (loading) return loading;
  const cached = memo ?? readCache();
  if (cached && !memo) {
    memo = cached;
    notify();
  }
  loading = api<{ version: number; notModified: boolean; sets: StickerSet[] }>(`/stickers${cached ? `?ver=${cached.version}` : ''}`)
    .then((r) => {
      if (!r.notModified) {
        memo = { version: r.version, sets: r.sets };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(memo)); } catch { /* 存不下就算了 */ }
        pruneRecent();
        notify();
      }
      return memo?.sets ?? [];
    })
    .catch(() => memo?.sets ?? [])
    .finally(() => { loading = null; });
  return loading;
}

function notify() {
  listeners.forEach((l) => l());
}

export function getRecent(): StickerPayload[] {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 后台下架的包：把「最近使用」里已经不在目录中的贴纸清掉 */
function pruneRecent() {
  if (!memo) return;
  const alive = new Set(memo.sets.flatMap((s) => s.items.map((i) => i.id)));
  const cur = getRecent();
  const next = cur.filter((p) => alive.has(p.id));
  if (next.length !== cur.length) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
}

export function addRecent(p: StickerPayload) {
  const list = [p, ...getRecent().filter((x) => x.id !== p.id)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  notify();
}

// ---------- 我的表情包（表情商店） ----------

const MINE_KEY = 'pw_sticker_mine';
let mineIds: number[] | null = null;
let mineLoading: Promise<number[]> | null = null;

function readMineCache(): number[] | null {
  try {
    const a = JSON.parse(localStorage.getItem(MINE_KEY) || 'null');
    return Array.isArray(a) ? a.map(Number) : null;
  } catch {
    return null;
  }
}

function setMine(ids: number[]) {
  mineIds = ids;
  try { localStorage.setItem(MINE_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
  notify();
}

/** 我面板里的集合 id（有序）。先用本地缓存，再问后端（每次打开面板都会刷一次，很小） */
export function loadMine(force = false): Promise<number[]> {
  if (mineIds === null) {
    const c = readMineCache();
    if (c) mineIds = c;
  }
  if (mineLoading) return mineLoading;
  if (mineIds !== null && !force) {
    // 后台静默刷新
    mineLoading = api<{ ids: number[] }>('/stickers/mine').then((r) => { setMine(r.ids); return r.ids; }).catch(() => mineIds ?? []).finally(() => { mineLoading = null; });
    return Promise.resolve(mineIds);
  }
  mineLoading = api<{ ids: number[] }>('/stickers/mine').then((r) => { setMine(r.ids); return r.ids; }).catch(() => mineIds ?? []).finally(() => { mineLoading = null; });
  return mineLoading;
}

export async function addMine(setId: number) {
  const r = await api<{ ids: number[] }>(`/stickers/mine/${setId}`, { method: 'POST' });
  setMine(r.ids);
}
export async function removeMine(setId: number) {
  const r = await api<{ ids: number[] }>(`/stickers/mine/${setId}`, { method: 'DELETE' });
  setMine(r.ids);
}
export async function reorderMine(ids: number[]) {
  setMine(ids);
  const r = await api<{ ids: number[] }>('/stickers/mine', { method: 'PUT', body: { ids } });
  setMine(r.ids);
}

/** 目录 + 我的（有序）+ 最近使用（自动订阅变化） */
export function useStickers() {
  const [sets, setSets] = useState<StickerSet[]>(memo?.sets ?? []);
  const [ids, setIds] = useState<number[]>(mineIds ?? []);
  const [recent, setRecent] = useState<StickerPayload[]>(getRecent);
  useEffect(() => {
    const l = () => { setSets(memo?.sets ?? []); setIds(mineIds ?? []); setRecent(getRecent()); };
    listeners.add(l);
    loadStickers();
    loadMine();
    return () => { listeners.delete(l); };
  }, []);
  const mine = ids.map((id) => sets.find((s) => s.id === id)).filter((s): s is StickerSet => !!s);
  return { sets, mine, mineIds: ids, recent };
}

export function parseSticker(content: string): StickerPayload | null {
  try {
    const o = JSON.parse(content);
    return o && typeof o.url === 'string' ? (o as StickerPayload) : null;
  } catch {
    return null;
  }
}
