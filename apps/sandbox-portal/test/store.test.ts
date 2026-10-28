import { describe, expect, test } from "vitest";
import type { Household, StoredFile, SubmitInput } from "../src/store";
import { MemoryStore } from "./memory-store";
import { makeSqlStore } from "./sql-store";

const HOUSEHOLD: Household = {
  fullName: "Maria Santos",
  dateOfBirth: "1988-04-12",
  address: "42 Test Street, Fresno, CA 93701",
  phone: "555-010-2030",
  householdSize: "3",
  monthlyIncome: "2400",
};

const FILES: StoredFile[] = [{ name: "paystub.pdf", type: "application/pdf", size: 14, data: "ZmFrZS1wZGYtYnl0ZXM=" }];

function input(key: string, household: Household = HOUSEHOLD): SubmitInput {
  return { key, household, files: FILES, source: "api", slowMs: 0, receivedAt: Date.now() };
}

describe("blocker 1: atomic submit", () => {
  test("MemoryStore: concurrent submits file once, winner keeps its receipt", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.submit(input("race-key"))));
    expect(results.filter((r) => r.outcome === "stored")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(49);
    const confirmations = new Set(results.map((r) => r.submission.confirmationNumber));
    expect(confirmations.size).toBe(1);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("MemoryStore: a second packet under the same key never overwrites the receipt", async () => {
    const store = new MemoryStore();
    const first = await store.submit(input("same-key", HOUSEHOLD));
    const second = await store.submit(input("same-key", { ...HOUSEHOLD, fullName: "Somebody Else" }));
    expect(first.outcome).toBe("stored");
    expect(second.outcome).toBe("duplicate");
    expect(second.submission.household.fullName).toBe("Maria Santos");
    expect(second.submission.confirmationNumber).toBe(first.submission.confirmationNumber);
  });

  test("MemoryStore: confirmation numbers are unique", async () => {
    const store = new MemoryStore();
    const confirmations = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = await store.submit(input(`key-${i}`));
      confirmations.add(result.submission.confirmationNumber);
    }
    expect(confirmations.size).toBe(50);
  });

  test("SQLite store: first writer wins, receipt is never replaced", async () => {
    const store = makeSqlStore();
    const first = await store.submit(input("race-key", HOUSEHOLD));
    expect(first.outcome).toBe("stored");
    const second = await store.submit(input("race-key", { ...HOUSEHOLD, fullName: "Somebody Else" }));
    expect(second.outcome).toBe("duplicate");
    expect(second.submission.confirmationNumber).toBe(first.submission.confirmationNumber);
    const peeked = await store.getSubmission("race-key");
    expect(peeked?.household.fullName).toBe("Maria Santos");
    expect(peeked?.confirmationNumber).toBe(first.submission.confirmationNumber);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("SQLite store: confirmation numbers are unique", async () => {
    const store = makeSqlStore();
    const confirmations = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const result = await store.submit(input(`key-${i}`));
      confirmations.add(result.submission.confirmationNumber);
    }
    expect(confirmations.size).toBe(25);
  });
});
