import { describe, expect, it } from "vitest";

import { CLAIM_TTL_MS, MemoryReminderStore, type Reminder, type ReminderStore } from "../agent/lib/reminders.js";
import { KvReminderStore } from "../agent/lib/reminders-kv.js";
import type { RedisLike } from "../agent/lib/storage.js";

// Single-key Redis semantics for the commands the store uses.
class FakeRedis implements RedisLike {
  private values = new Map<string, { value: unknown; expiresAtMs: number }>();
  private hashes = new Map<string, Record<string, unknown>>();
  private zsets = new Map<string, Map<string, number>>();
  now = Date.now();

  private live(key: string) {
    const v = this.values.get(key);
    if (v && v.expiresAtMs <= this.now) this.values.delete(key);
    return this.values.get(key);
  }
  async get<T>(key: string): Promise<T | null> {
    return (this.live(key)?.value as T) ?? null;
  }
  async set(key: string, value: unknown, opts: { nx?: boolean; px?: number } = {}): Promise<unknown> {
    if (opts.nx && this.live(key)) return null;
    this.values.set(key, { value, expiresAtMs: opts.px ? this.now + opts.px : Infinity });
    return "OK";
  }
  async del(...keys: string[]): Promise<unknown> {
    for (const k of keys) {
      this.values.delete(k);
      this.hashes.delete(k);
    }
    return keys.length;
  }
  async hset(key: string, value: Record<string, unknown>): Promise<unknown> {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...value });
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, unknown> | null> {
    return this.hashes.get(key) ?? null;
  }
  async zadd(key: string, ...args: Array<{ score: number; member: string }>): Promise<unknown> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    for (const a of args) z.set(a.member, a.score);
    this.zsets.set(key, z);
    return args.length;
  }
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const z = [...(this.zsets.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    return z.slice(start, stop + 1);
  }
  async zrem(key: string, ...members: string[]): Promise<unknown> {
    for (const m of members) this.zsets.get(key)?.delete(m);
    return members.length;
  }
}

const HANDLE = "a".repeat(64);
const NOW = Date.now();

function row(overrides: Partial<Reminder> = {}): Reminder {
  return { id: "rem_1", handleHash: HANDLE, generation: 0, text: "call the office", dueAtMs: NOW - 1000, createdAtMs: 1, sentAtMs: null, ...overrides };
}

const stores: Array<[string, () => ReminderStore]> = [
  ["memory", () => new MemoryReminderStore()],
  ["redis", () => new KvReminderStore(new FakeRedis())],
];

describe.each(stores)("%s reminder store", (_name, make) => {
  it("lists due unsent rows oldest first", async () => {
    const store = make();
    await store.create(row({ id: "future", dueAtMs: NOW + 60_000 }));
    await store.create(row({ id: "sent", dueAtMs: NOW - 5000, sentAtMs: NOW - 4000 }));
    await store.create(row({ id: "old", dueAtMs: NOW - 3000 }));
    await store.create(row({ id: "new", dueAtMs: NOW - 2000 }));
    expect(await store.dueIds(NOW, 10)).toEqual(["old", "new"]);
  });

  it("claims a row for one sender at a time, and sent rows never again", async () => {
    const store = make();
    await store.create(row({ id: "a" }));
    expect(await store.beginSend("a", NOW)).not.toBeNull();
    expect(await store.beginSend("a", NOW)).toBeNull();
    await store.releaseSend("a");
    expect(await store.beginSend("a", NOW)).not.toBeNull();
    await store.markSent("a", NOW);
    await store.releaseSend("a");
    expect(await store.beginSend("a", NOW)).toBeNull();
    expect(await store.dueIds(NOW, 10)).toEqual([]);
  });

  it("cancel before the send claim: never sent", async () => {
    const store = make();
    await store.create(row({ id: "a" }));
    expect(await store.cancel("a", HANDLE)).toBe("cancelled");
    expect(await store.beginSend("a", NOW)).toBeNull();
  });

  it("cancel after the send claim: reported as sending, not cancelled", async () => {
    const store = make();
    await store.create(row({ id: "a" }));
    expect(await store.beginSend("a", NOW)).not.toBeNull();
    expect(await store.cancel("a", HANDLE)).toBe("sending");
    // If that delivery fails, the retry still respects the cancellation.
    await store.releaseSend("a");
    expect(await store.beginSend("a", NOW)).toBeNull();
  });

  it("lists and cancels only the owner's rows", async () => {
    const store = make();
    await store.create(row({ id: "a" }));
    await store.create(row({ id: "b", handleHash: "b".repeat(64) }));
    expect((await store.listForHandle(HANDLE)).map((r) => r.id)).toEqual(["a"]);
    expect(await store.cancel("a", "b".repeat(64))).toBe("not_found");
    expect(await store.cancel("a", HANDLE)).toBe("cancelled");
    expect(await store.listForHandle(HANDLE)).toEqual([]);
  });

  it("create converges on the first row for an ID", async () => {
    const store = make();
    const first = await store.create(row({ id: "a", text: "first" }));
    const again = await store.create(row({ id: "a", text: "second" }));
    expect(again).toEqual(first);
  });
});

describe("redis send claim expiry", () => {
  it("expires a claim so a crashed delivery is retried", async () => {
    const redis = new FakeRedis();
    const store = new KvReminderStore(redis);
    await store.create(row({ id: "a" }));
    expect(await store.beginSend("a", NOW)).not.toBeNull();
    redis.now += CLAIM_TTL_MS + 1;
    expect(await store.beginSend("a", NOW)).not.toBeNull();
  });
});
