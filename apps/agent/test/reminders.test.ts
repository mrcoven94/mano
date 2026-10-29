import { describe, expect, it } from "vitest";

import { MemoryReminderStore } from "../agent/lib/reminders.js";
import type { Reminder } from "../agent/lib/reminders.js";

function row(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "rem_1",
    handleHash: "a".repeat(64),
    text: "call the office",
    dueAtMs: 1000,
    createdAtMs: 500,
    claimedAtMs: null,
    sentAtMs: null,
    ...overrides,
  };
}

describe("memory reminder store", () => {
  it("claims due rows oldest first and skips sent and future rows", async () => {
    const store = new MemoryReminderStore();
    await store.create(row({ id: "future", dueAtMs: 5000 }));
    await store.create(row({ id: "sent", dueAtMs: 100, sentAtMs: 200 }));
    await store.create(row({ id: "old", dueAtMs: 100 }));
    await store.create(row({ id: "new", dueAtMs: 900 }));
    const claimed = await store.claimDue(1000, 10);
    expect(claimed.map((r) => r.id)).toEqual(["old", "new"]);
    expect(await store.claimDue(1000, 10)).toEqual([]);
  });

  it("expires claims so crashes redeliver", async () => {
    const store = new MemoryReminderStore();
    await store.create(row({ id: "a", dueAtMs: 100 }));
    expect(await store.claimDue(1000, 10)).toHaveLength(1);
    // Still claimed a minute later.
    expect(await store.claimDue(1000 + 60_000, 10)).toHaveLength(0);
    // Claim expired after the TTL.
    expect(await store.claimDue(1000 + 11 * 60_000, 10)).toHaveLength(1);
  });

  it("marks sent and releases claims", async () => {
    const store = new MemoryReminderStore();
    await store.create(row({ id: "a", dueAtMs: 100 }));
    await store.claimDue(1000, 10);
    await store.releaseClaim("a");
    expect(await store.claimDue(1000, 10)).toHaveLength(1);
    await store.markSent("a", 1000);
    expect(await store.claimDue(2000, 10)).toHaveLength(0);
  });

  it("lists and cancels per handle", async () => {
    const store = new MemoryReminderStore();
    await store.create(row({ id: "a", handleHash: "h1" }));
    await store.create(row({ id: "b", handleHash: "h2" }));
    expect((await store.listForHandle("h1")).map((r) => r.id)).toEqual(["a"]);
    expect(await store.cancel("a", "h2")).toBe(false);
    expect(await store.cancel("a", "h1")).toBe(true);
    expect(await store.listForHandle("h1")).toEqual([]);
  });
});
