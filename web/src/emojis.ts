import { useEffect, useState } from 'react';
import { api } from './api';

/** [emoji, 中文名, 关键词（中英文空格分隔）] */
export type EmojiItem = [string, string, string];
export interface EmojiGroup {
  key: string;
  name: string;
  icon: string;
  items: EmojiItem[];
}

const CACHE_KEY = 'pw_emojis_v1';
const RECENT_KEY = 'pw_emoji_recent';
const RECENT_MAX = 32;

let memo: { version: number; groups: EmojiGroup[] } | null = null;
let loading: Promise<EmojiGroup[]> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Unicode emoji 分类数据（后端 /emojis 提供，localStorage 缓存，按 version 增量） */
export function loadEmojis(): Promise<EmojiGroup[]> {
  if (memo) return Promise.resolve(memo.groups);
  if (loading) return loading;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const o = raw ? JSON.parse(raw) : null;
    if (o && Array.isArray(o.groups) && o.groups.length) { memo = o; notify(); }
  } catch { /* ignore */ }
  loading = api<{ version: number; notModified: boolean; groups: EmojiGroup[] }>(`/emojis${memo ? `?ver=${memo.version}` : ''}`)
    .then((r) => {
      if (!r.notModified && r.groups?.length) {
        memo = { version: r.version, groups: r.groups };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(memo)); } catch { /* ignore */ }
        notify();
      }
      return memo?.groups ?? [];
    })
    .catch(() => memo?.groups ?? [])
    .finally(() => { loading = null; });
  return loading;
}

export function getRecentEmojis(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function addRecentEmoji(e: string) {
  const list = [e, ...getRecentEmojis().filter((x) => x !== e)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  notify();
}

/** 关键词搜索（中英文都行，空格分词全部命中） */
export function searchEmojis(groups: EmojiGroup[], q: string, limit = 120): EmojiItem[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: EmojiItem[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      const hay = `${it[1]} ${it[2]}`.toLowerCase();
      if (words.every((w) => hay.includes(w) || it[0] === w)) {
        out.push(it);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export function useEmojis() {
  const [groups, setGroups] = useState<EmojiGroup[]>(memo?.groups ?? []);
  const [recent, setRecent] = useState<string[]>(getRecentEmojis);
  useEffect(() => {
    const l = () => { setGroups(memo?.groups ?? []); setRecent(getRecentEmojis()); };
    listeners.add(l);
    loadEmojis();
    return () => { listeners.delete(l); };
  }, []);
  return { groups, recent };
}

/** 删掉字符串末尾一个「用户看到的字符」（emoji 可能由多个码点 + ZWJ 组成） */
export function dropLastGrapheme(s: string): string {
  if (!s) return s;
  const Seg = (Intl as any).Segmenter;
  if (Seg) {
    const parts = Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s)) as { segment: string }[];
    parts.pop();
    return parts.map((p) => p.segment).join('');
  }
  const arr = Array.from(s);
  arr.pop();
  return arr.join('');
}
