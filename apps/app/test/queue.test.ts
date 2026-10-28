import { describe, expect, it } from "vitest";
import { AuthError, type Session } from "../lib/api/types";
import { MemoryStore } from "../lib/kv";
import { Outbox } from "../lib/queue";

function sessionFor(personId: string): Session {
  return {
    token: `token-${personId}`,
    personId,
    email: `${personId}@example.com`,
    displayName: personId,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

const ALICE = sessionFor("alice");
const BETO = sessionFor("beto");

describe("Outbox", () => {
  it("persists queued messages across instances", async () => {
    const store = new MemoryStore();
    const a = new Outbox(store);
    const item = await a.enqueue("alice", "hello", []);
    expect(item.personId).toBe("alice");
    expect(item.id).toBeTruthy();
    const b = new Outbox(store);
    const listed = await b.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(item.id);
    expect(listed[0]?.text).toBe("hello");
  });

  it("flushes in order and stops at the first failure", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("alice", "one", []);
    await outbox.enqueue("alice", "two", []);
    await outbox.enqueue("alice", "three", []);
    const sent: string[] = [];
    const report = await outbox.flush(ALICE, async (item) => {
      if (item.text === "two") throw new Error("offline");
      sent.push(item.text);
    });
    expect(sent).toEqual(["one"]);
    expect(report.sent).toHaveLength(1);
    expect(report.kept).toHaveLength(2);
    const remaining = await outbox.list();
    expect(remaining.map((i) => i.text)).toEqual(["two", "three"]);
    expect(remaining[0]?.attempts).toBe(1);
  });

  it("never sends one resident's mail under another session", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("alice", "alice mail", []);
    const sent: string[] = [];
    const report = await outbox.flush(BETO, async (item) => {
      sent.push(item.text);
    });
    expect(sent).toHaveLength(0);
    expect(report.droppedForeign).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("drops the item and rethrows on auth errors instead of queueing", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("alice", "one", []);
    await expect(
      outbox.flush(ALICE, async () => {
        throw new AuthError();
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("sends each item once when two flushes race", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("alice", "one", []);
    await outbox.enqueue("alice", "two", []);
    const sent: string[] = [];
    const slowSend = async (item: { id: string }) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(item.id);
    };
    const [first, second] = await Promise.all([outbox.flush(ALICE, slowSend), outbox.flush(ALICE, slowSend)]);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(first.sent.length + second.sent.length).toBe(2);
  });

  it("keeps items enqueued mid-flush for the next flush", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("alice", "one", []);
    const sent: string[] = [];
    const flushing = outbox.flush(ALICE, async (item) => {
      await new Promise((r) => setTimeout(r, 30));
      sent.push(item.text);
    });
    await new Promise((r) => setTimeout(r, 5));
    await outbox.enqueue("alice", "two", []);
    const first = await flushing;
    expect(sent).toEqual(["one"]);
    expect(first.kept).toEqual([]);
    const second = await outbox.flush(ALICE, async (item) => {
      sent.push(item.text);
    });
    expect(second.sent).toHaveLength(1);
    expect(sent).toEqual(["one", "two"]);
  });

  it("empties on a clean flush and on clear", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("alice", "one", []);
    const report = await outbox.flush(ALICE, async () => {});
    expect(report.kept).toHaveLength(0);
    expect(await outbox.list()).toHaveLength(0);
    await outbox.enqueue("alice", "two", []);
    await outbox.clear();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("refuses to grow past its cap instead of dropping mail", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    for (let i = 0; i < 20; i++) await outbox.enqueue("alice", `m-${i}`, []);
    await expect(outbox.enqueue("alice", "overflow", [])).rejects.toThrow("outbox is full");
    expect(await outbox.list()).toHaveLength(20);
  });
});
