import { describe, expect, it } from "vitest";
import { GlobalLedger, MemoryGlobalStore } from "../src/global.js";

describe("GlobalLedger", () => {
  it("checks and records spend within the day", () => {
    let now = Date.parse("2026-10-28T12:00:00Z");
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => now, 5);
    expect(ledger.check(1)).toEqual({ allowed: true, spentUsd: 0 });
    ledger.record(4.5);
    expect(ledger.check(1).allowed).toBe(false);
    expect(ledger.check(0.4).allowed).toBe(true);
  });

  it("resets spend on a new UTC day", () => {
    let now = Date.parse("2026-10-28T12:00:00Z");
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => now, 5);
    ledger.record(4.9);
    now += 24 * 3600 * 1000;
    expect(ledger.check(1)).toEqual({ allowed: true, spentUsd: 0 });
  });

  it("holds the reconcile cursor", () => {
    const ledger = new GlobalLedger(new MemoryGlobalStore(), () => Date.now(), 5);
    expect(ledger.cursor()).toBeNull();
    ledger.saveCursor("cursor_9");
    expect(ledger.cursor()).toBe("cursor_9");
  });
});
