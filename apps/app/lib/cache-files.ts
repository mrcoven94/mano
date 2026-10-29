// Manifest of cache files the app wrote for the current resident
// (PDF temp files, share copies, voice previews). The manifest lives
// in the person's own store, so sign-out deletes every file it names.

import type { KeyValue } from "./kv";

const CACHE_KEY = "cache.v1";

export async function trackCacheFile(store: KeyValue, uri: string): Promise<void> {
  const current = await listCacheFiles(store);
  if (current.includes(uri)) return;
  await store.set(CACHE_KEY, JSON.stringify([...current, uri]));
}

export async function listCacheFiles(store: KeyValue): Promise<string[]> {
  const raw = await store.get(CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export async function untrackCacheFile(store: KeyValue, uri: string): Promise<void> {
  const rest = (await listCacheFiles(store)).filter((u) => u !== uri);
  await store.set(CACHE_KEY, JSON.stringify(rest));
}

export async function clearCacheFiles(store: KeyValue): Promise<void> {
  await store.remove(CACHE_KEY);
}
