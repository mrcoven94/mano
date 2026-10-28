import { describe, expect, it } from "vitest";
import { GlobalLedger, MemoryGlobalStore } from "../src/global.js";

describe("GlobalLedger reservations", () => {
  it("holds worst-case cost so concurrent turns cannot overshoot", () => {
    let now = Date.parse("2026-10-28T12:00:00Z");
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => now, 5);
    expect(ledger.reserve("a:1", 3)).toEqual({ allowed: true, spentUsd: 0 });
    expect(ledger.reserve("b:1", 3).allowed).toBe(false);
    expect(ledger.reserve("b:1", 2).allowed).toBe(true);
    ledger.settle("a:1", 1);
    expect(ledger.spent().spentUsd).toBeCloseTo(1);
    expect(ledger.reserve("c:1", 3).allowed).toBe(false);
    expect(ledger.reserve("c:1", 2).allowed).toBe(true);
  });

  it("reusing a key does not hold twice", () => {
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => Date.parse("2026-10-28T12:00:00Z"), 5);
    expect(ledger.reserve("a:1", 4).allowed).toBe(true);
    expect(ledger.reserve("a:1", 4)).toEqual({ allowed: true, spentUsd: 0 });
    ledger.settle("a:1", 0.5);
    expect(ledger.spent().spentUsd).toBeCloseTo(0.5);
  });

  it("resets spend and holds on a new UTC day", () => {
    let now = Date.parse("2026-10-28T12:00:00Z");
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => now, 5);
    ledger.reserve("a:1", 4.9);
    ledger.settle("a:1", 4.9);
    now += 24 * 3600 * 1000;
    expect(ledger.reserve("b:2", 4.9)).toEqual({ allowed: true, spentUsd: 0 });
  });

  it("reserves and settles bytes against the daily budget", () => {
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => Date.parse("2026-10-28T12:00:00Z"), 5, 100);
    expect(ledger.byteReserve("a:1:0", 60).allowed).toBe(true);
    expect(ledger.byteReserve("b:1:0", 60).allowed).toBe(false);
    ledger.byteSettle("a:1:0", 10);
    expect(ledger.byteReserve("b:1:0", 60).allowed).toBe(true);
  });

  it("holds the reconcile cursor", () => {
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => Date.now(), 5);
    expect(ledger.cursor()).toBeNull();
    ledger.saveCursor("cursor_9");
    expect(ledger.cursor()).toBe("cursor_9");
  });
});

describe("sweepExpiredFiles", () => {
  it("deletes files older than 30 days and keeps the rest", async () => {
    const { MemoryFileStore } = await import("../src/files.js");
    const { sweepExpiredFiles } = await import("../src/index.js");
    const { ATTACHMENT_RETENTION_MS } = await import("@mano/channels");
    const files = new MemoryFileStore();
    const now = Date.parse("2026-10-28T12:00:00Z");
    await files.put("persons/a/docs/old", new TextEncoder().encode("old"), now - ATTACHMENT_RETENTION_MS - 1000);
    await files.put("persons/a/docs/new", new TextEncoder().encode("new"), now - 1000);
    expect(await sweepExpiredFiles(files, now)).toEqual({ deleted: 1 });
    expect(files.files.has("persons/a/docs/old")).toBe(false);
    expect(files.files.has("persons/a/docs/new")).toBe(true);
  });
});
