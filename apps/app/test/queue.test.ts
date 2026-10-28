import { describe, expect, it } from "vitest";
import { Outbox } from "../lib/queue";
import type { KeyValue } from "../lib/storage";

class TestStore implements KeyValue {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

describe("Outbox", () => {
  it("persists queued messages across instances", async () => {
    const store = new TestStore();
    const a = new Outbox(store);
    const item = await a.enqueue("hello", []);
    const b = new Outbox(store);
    const listed = await b.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(item.id);
    expect(listed[0]?.text).toBe("hello");
  });

  it("flushes in order and stops at the first failure", async () => {
    const store = new TestStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("one", []);
    await outbox.enqueue("two", []);
    await outbox.enqueue("three", []);
    const sent: string[] = [];
    const report = await outbox.flush(async (item) => {
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

  it("empties on a clean flush", async () => {
    const store = new TestStore();
    const outbox = new Outbox(store);
    await outbox.enqueue("one", []);
    const report = await outbox.flush(async () => {});
    expect(report.kept).toHaveLength(0);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("refuses to grow past its cap instead of dropping mail", async () => {
    const store = new TestStore();
    const outbox = new Outbox(store);
    for (let i = 0; i < 20; i++) await outbox.enqueue(`m-${i}`, []);
    await expect(outbox.enqueue("overflow", [])).rejects.toThrow("outbox is full");
    expect(await outbox.list()).toHaveLength(20);
  });
});
