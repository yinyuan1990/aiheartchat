"use client";

import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { BoatError, type BoatMe } from "@/lib/boat";

// 防捞女剧情游戏「清醒局」: script + $BOAT ledger in indexer story.ts (same session token as the boat games).

export type T = { zh: string; en: string };
export type Line = { who: "her" | "me" | "nar" | "net"; t: T; at?: T };
export type Choice = { t: T; ok: boolean; why: T };
export type Step = { lines: Line[]; ask: T; choices: Choice[]; real: T };
export type Level = { id: number; title: T; tagline: T; basedOn: T; me: T; her: T; steps: Step[]; lesson: T; recap: T[]; sources: { name: string; url: string }[] };
export type StoryInfo = { reward: number; entry: number; hearts: number; rate: number; levels: Level[]; cleared: Record<number, number> };
export type StoryStart = { id?: string; paid?: number; cleared?: boolean; practice?: true; me: BoatMe };
export type StoryEnd = { hearts: number; passed: boolean; reward: number; rate: number; me: BoatMe; cleared: Record<number, number> };

async function call<T>(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/story${path}`, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new BoatError(j.error ?? `HTTP ${res.status}`, res.status);
  return j;
}

export const useStory = (token: string | null) => useQuery({ queryKey: ["story", token], queryFn: () => call<StoryInfo>("/levels", { token }), staleTime: 30_000 });
export const storyStart = (token: string, level: number) => call<StoryStart>(`/${level}/start`, { method: "POST", token, body: {} });
export const storyEnd = (token: string, id: string, choices: number[]) => call<StoryEnd>(`/run/${id}/end`, { method: "POST", token, body: { choices } });
