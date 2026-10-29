import { describe, expect, test } from "vitest";
import { canonicalPacket, packetDigest, sha256Hex, type FileMeta, type Household, type Submission, type SubmitInput, type SubmitResult } from "../src/store";
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

const FILES: FileMeta[] = [
  { name: "paystub.pdf", type: "application/pdf", size: 14, sha256: "abc", r2key: "submissions/web/k/1-abc" },
];

function input(key: string, digest = "digest-a", household: Household = HOUSEHOLD, scope = "web"): SubmitInput {
  return { key, scope, household, files: FILES, digest, source: "api", slowMs: 0, receivedAt: Date.now() };
}

function filed(result: SubmitResult): Submission {
  if (result.outcome !== "stored" && result.outcome !== "duplicate") throw new Error(`unexpected ${result.outcome}`);
  return result.submission;
}

describe("blocker 1: atomic submit", () => {
  test("MemoryStore: concurrent submits file once, winner keeps its receipt", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.submit(input("race-key"))));
    expect(results.filter((r) => r.outcome === "stored")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(49);
    const confirmations = new Set(results.map((r) => filed(r).confirmationNumber));
    expect(confirmations.size).toBe(1);
    expect((await store.countSubmissions())).toBe(1);
  });

  test("MemoryStore: a second packet under the same key never overwrites the receipt", async () => {
    const store = new MemoryStore();
    const first = await store.submit(input("same-key", "digest-a", HOUSEHOLD));
    const second = await store.submit(input("same-key", "digest-a", { ...HOUSEHOLD, fullName: "Somebody Else" }));
    expect(first.outcome).toBe("stored");
    expect(second.outcome).toBe("duplicate");
    expect(filed(second).household.fullName).toBe("Maria Santos");
    expect(filed(second).confirmationNumber).toBe(filed(first).confirmationNumber);
  });

  test("MemoryStore: confirmation numbers are unique", async () => {
    const store = new MemoryStore();
    const confirmations = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = await store.submit(input(`key-${i}`));
      if (result.outcome !== "stored") throw new Error("expected stored");
      confirmations.add(result.submission.confirmationNumber);
    }
    expect(confirmations.size).toBe(50);
  });

  test("SQLite store: first writer wins, receipt is never replaced", async () => {
    const store = makeSqlStore();
    const first = await store.submit(input("race-key", "digest-a", HOUSEHOLD));
    expect(first.outcome).toBe("stored");
    const second = await store.submit(input("race-key", "digest-a", { ...HOUSEHOLD, fullName: "Somebody Else" }));
    expect(second.outcome).toBe("duplicate");
    expect(filed(second).confirmationNumber).toBe(filed(first).confirmationNumber);
    const peeked = await store.getSubmission("web", "race-key");
    expect(peeked?.household.fullName).toBe("Maria Santos");
    expect(peeked?.confirmationNumber).toBe(filed(first).confirmationNumber);
    expect((await store.countSubmissions())).toBe(1);
  });

  test("SQLite store: confirmation numbers are unique", async () => {
    const store = makeSqlStore();
    const confirmations = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const result = await store.submit(input(`key-${i}`));
      if (result.outcome !== "stored") throw new Error(`unexpected ${result.outcome}`);
      confirmations.add(result.submission.confirmationNumber);
    }
    expect(confirmations.size).toBe(25);
  });
});

describe("blocker 2: packet digest", () => {
  const fileDigests = [{ name: "paystub.pdf", type: "application/pdf", size: 14, sha256: "abc" }];

  test("equal packets digest equally, any change digests differently", async () => {
    const a = await packetDigest(HOUSEHOLD, fileDigests);
    const b = await packetDigest({ ...HOUSEHOLD }, [...fileDigests]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const changedHousehold = await packetDigest({ ...HOUSEHOLD, monthlyIncome: "2401" }, fileDigests);
    expect(changedHousehold).not.toBe(a);
    const changedBytes = await packetDigest(HOUSEHOLD, [{ ...fileDigests[0]!, sha256: "abd" }]);
    expect(changedBytes).not.toBe(a);
    expect(canonicalPacket(HOUSEHOLD, fileDigests)).toContain('"fullName":"Maria Santos"');
    expect(await sha256Hex("mano")).toHaveLength(64);
  });

  test("MemoryStore: same key and digest duplicates, different digest conflicts", async () => {
    const store = new MemoryStore();
    const first = await store.submit(input("k", "digest-a"));
    expect(first.outcome).toBe("stored");
    const dup = await store.submit(input("k", "digest-a"));
    expect(dup.outcome).toBe("duplicate");
    const conflict = await store.submit(input("k", "digest-b"));
    expect(conflict.outcome).toBe("conflict");
    if (conflict.outcome !== "conflict") throw new Error("expected a conflict");
    if (first.outcome !== "stored") throw new Error("expected stored");
    expect(conflict.stored.confirmationNumber).toBe(first.submission.confirmationNumber);
    expect(conflict.stored.digest).toBe("digest-a");
  });

  test("SQLite store: same key and digest duplicates, different digest conflicts", async () => {
    const store = makeSqlStore();
    const first = await store.submit(input("k", "digest-a"));
    expect(first.outcome).toBe("stored");
    const dup = await store.submit(input("k", "digest-a"));
    expect(dup.outcome).toBe("duplicate");
    const conflict = await store.submit(input("k", "digest-b"));
    expect(conflict.outcome).toBe("conflict");
    if (conflict.outcome !== "conflict") throw new Error("expected a conflict");
    expect(conflict.stored.digest).toBe("digest-a");
    expect((await store.countSubmissions())).toBe(1);
  });
});

describe("blocker 3: scopes", () => {
  test("MemoryStore: the same key files independently in each scope", async () => {
    const store = new MemoryStore();
    const a = await store.submit(input("k", "digest-a", HOUSEHOLD, "api-1"));
    const b = await store.submit(input("k", "digest-b", HOUSEHOLD, "api-2"));
    expect(a.outcome).toBe("stored");
    expect(b.outcome).toBe("stored");
    expect(filed(a).confirmationNumber).not.toBe(filed(b).confirmationNumber);
    expect((await store.getSubmission("api-1", "k"))?.digest).toBe("digest-a");
    expect(await store.getSubmission("web", "k")).toBeNull();
  });

  test("SQLite store: the same key files independently in each scope", async () => {
    const store = makeSqlStore();
    const a = await store.submit(input("k", "digest-a", HOUSEHOLD, "api-1"));
    const b = await store.submit(input("k", "digest-b", HOUSEHOLD, "api-2"));
    expect(a.outcome).toBe("stored");
    expect(b.outcome).toBe("stored");
    expect(await store.getSubmission("web", "k")).toBeNull();
    expect((await store.getSubmission("api-2", "k"))?.digest).toBe("digest-b");
  });
});

describe("blocker 6: rate limits and slow leases", () => {
  test("MemoryStore: fixed window allows the max, then resets", async () => {
    const store = new MemoryStore();
    expect(await store.checkRateLimit("1.2.3.4", 1000, 60_000, 2)).toBe(true);
    expect(await store.checkRateLimit("1.2.3.4", 2000, 60_000, 2)).toBe(true);
    expect(await store.checkRateLimit("1.2.3.4", 3000, 60_000, 2)).toBe(false);
    expect(await store.checkRateLimit("5.6.7.8", 3000, 60_000, 2)).toBe(true);
    expect(await store.checkRateLimit("1.2.3.4", 61_001, 60_000, 2)).toBe(true);
  });

  test("SQLite store: fixed window allows the max, then resets", async () => {
    const store = makeSqlStore();
    expect(await store.checkRateLimit("1.2.3.4", 1000, 60_000, 2)).toBe(true);
    expect(await store.checkRateLimit("1.2.3.4", 2000, 60_000, 2)).toBe(true);
    expect(await store.checkRateLimit("1.2.3.4", 3000, 60_000, 2)).toBe(false);
    expect(await store.checkRateLimit("1.2.3.4", 61_001, 60_000, 2)).toBe(true);
  });

  test("MemoryStore: slow leases cap concurrency and expire", async () => {
    const store = new MemoryStore();
    const first = await store.tryBeginSlow(1000, 5000, 1);
    expect(first).not.toBeNull();
    expect(await store.tryBeginSlow(2000, 5000, 1)).toBeNull();
    await store.endSlow(first!);
    expect(await store.tryBeginSlow(3000, 5000, 1)).not.toBeNull();
    expect(await store.tryBeginSlow(9000, 5000, 1)).not.toBeNull();
  });

  test("SQLite store: slow leases cap concurrency and expire", async () => {
    const store = makeSqlStore();
    const first = await store.tryBeginSlow(1000, 5000, 1);
    expect(first).not.toBeNull();
    expect(await store.tryBeginSlow(2000, 5000, 1)).toBeNull();
    await store.endSlow(first!);
    expect(await store.tryBeginSlow(3000, 5000, 1)).not.toBeNull();
    await store.purgeExpiredSlowLeases(9000);
    expect(await store.tryBeginSlow(9000, 5000, 1)).not.toBeNull();
  });
});

describe("blocker 8: retention", () => {
  test("expired sessions list without deleting, then delete only if still expired", async () => {
    for (const store of [new MemoryStore(), makeSqlStore()]) {
      await store.putSession({ id: "old", files: [], key: "k", createdAt: 0, expiresAt: 1000 });
      await store.putSession({ id: "fresh", files: [], key: "k", createdAt: 0, expiresAt: 9999 });
      const expired = await store.listExpiredSessions(2000);
      expect(expired.map((s) => s.id)).toEqual(["old"]);
      expect(await store.getSession("old")).not.toBeNull();
      // A renewal that lands after the listing wins: the re-checked delete spares it.
      expect(await store.renewSession({ id: "fresh", files: [], key: "k", createdAt: 0, expiresAt: 99999 }, 2000)).toBe(true);
      expect(await store.deleteSessionIfExpired("fresh", 2000)).toBeNull();
      const reaped = await store.deleteSessionIfExpired("old", 2000);
      expect(reaped?.id).toBe("old");
      expect(await store.getSession("old")).toBeNull();
      expect(await store.getSession("fresh")).not.toBeNull();
    }
  });

  test("summaries carry metadata only, newest first, with limit and offset", async () => {
    for (const store of [new MemoryStore(), makeSqlStore()]) {
      for (let i = 0; i < 3; i++) {
        await store.submit({ ...input(`k${i}`, `digest-${i}`, { ...HOUSEHOLD, fullName: `Person ${i}` }), receivedAt: 1000 + i });
      }
      expect(await store.countSubmissions()).toBe(3);
      const first = await store.listSubmissionSummaries(2, 0);
      expect(first.map((s) => s.applicant)).toEqual(["Person 2", "Person 1"]);
      expect(first[0]).toEqual({ confirmationNumber: first[0]!.confirmationNumber, applicant: "Person 2", receivedAt: 1002, fileCount: 1 });
      const second = await store.listSubmissionSummaries(2, 2);
      expect(second.map((s) => s.applicant)).toEqual(["Person 0"]);
      expect(JSON.stringify(first)).not.toContain("fullName");
    }
  });

  for (const [name, make] of [["MemoryStore", () => new MemoryStore()], ["SQLite store", () => makeSqlStore()]] as const) {
    test(`${name}: retire lists, writes receipts, then deletes; purge removes receipts`, async () => {
      const store = make();
      const stored = await store.submit({ ...input("k", "digest-a"), receivedAt: 1000 });
      if (stored.outcome !== "stored") throw new Error("expected stored");
      const old = await store.listOldSubmissions(2000, 500);
      expect(old.map((s) => s.key)).toEqual(["k"]);
      expect(await store.getSubmission("web", "k")).not.toBeNull();
      await store.writeReceipts(
        old.map((sub) => ({ key: sub.key, scope: sub.scope, confirmationNumber: sub.confirmationNumber, digest: sub.digest, receivedAt: sub.receivedAt })),
      );
      await store.deleteSubmissions([{ scope: "web", key: "k" }]);
      expect(await store.getSubmission("web", "k")).toBeNull();
      const receipt = await store.getReceipt("web", "k");
      expect(receipt?.confirmationNumber).toBe(stored.submission.confirmationNumber);
      expect(receipt?.digest).toBe("digest-a");
      expect(await store.purgeOldReceipts(2000)).toBe(1);
      expect(await store.getReceipt("web", "k")).toBeNull();
    });

    test(`${name}: staged objects track, list, claim by guard, and untrack`, async () => {
      const store = make();
      await store.trackStaged([
        { key: "staging/a/1-x", createdAt: 1000 },
        { key: "staging/b/1-y", createdAt: 9000 },
      ]);
      expect(await store.listTrackedStaged()).toEqual([
        { key: "staging/a/1-x", createdAt: 1000 },
        { key: "staging/b/1-y", createdAt: 9000 },
      ]);
      expect(await store.claimUnreferencedStaged([{ key: "staging/a/1-x", guard: { kind: "attempt", olderThan: 5000 } }])).toEqual(["staging/a/1-x"]);
      expect(await store.claimUnreferencedStaged([{ key: "staging/b/1-y", guard: { kind: "attempt", olderThan: 5000 } }])).toEqual([]);
      await store.untrackStaged(["staging/b/1-y"]);
      expect(await store.listTrackedStaged()).toEqual([]);
    });

    test(`${name}: renew refuses an expired or missing session and leaves the row alone`, async () => {
      const store = make();
      await store.putSession({ id: "s", files: [], key: "k", createdAt: 0, expiresAt: 1000 });
      expect(await store.renewSession({ id: "s", files: [], key: "k", createdAt: 0, expiresAt: 99999 }, 2000)).toBe(false);
      expect((await store.getSession("s"))?.expiresAt).toBe(1000);
      expect(await store.renewSession({ id: "missing", files: [], key: "k", createdAt: 0, expiresAt: 99999 }, 2000)).toBe(false);
      expect(await store.renewSession({ id: "s", files: [], key: "k", createdAt: 0, expiresAt: 99999 }, 500)).toBe(true);
      expect((await store.getSession("s"))?.expiresAt).toBe(99999);
    });

    test(`${name}: a draft claim fails while its owner session is alive, whatever its age`, async () => {
      const store = make();
      await store.putSession({ id: "live", files: [], key: "k", createdAt: 0, expiresAt: 99999 });
      await store.putSession({ id: "dead", files: [], key: "k", createdAt: 0, expiresAt: 1000 });
      await store.trackStaged([
        { key: "drafts/live/1-x", createdAt: 1000 },
        { key: "drafts/dead/1-y", createdAt: 1000 },
        { key: "drafts/gone/1-z", createdAt: 1000 },
      ]);
      expect(
        await store.claimUnreferencedStaged([
          { key: "drafts/live/1-x", guard: { kind: "session", sessionId: "live", now: 50000 } },
          { key: "drafts/dead/1-y", guard: { kind: "session", sessionId: "dead", now: 50000 } },
          { key: "drafts/gone/1-z", guard: { kind: "session", sessionId: "gone", now: 50000 } },
        ]),
      ).toEqual(["drafts/dead/1-y", "drafts/gone/1-z"]);
      expect((await store.listTrackedStaged()).map((e) => e.key)).toEqual(["drafts/live/1-x"]);
    });

    test(`${name}: a filed-copy claim fails while its submission row exists`, async () => {
      const store = make();
      const filed = await store.submit({ ...input("k", "digest-a"), receivedAt: 1000 });
      if (filed.outcome !== "stored") throw new Error("expected stored");
      await store.trackStaged([
        { key: "submissions/web/k/1-x", createdAt: 1000 },
        { key: "submissions/web/gone/1-y", createdAt: 1000 },
      ]);
      expect(
        await store.claimUnreferencedStaged([
          { key: "submissions/web/k/1-x", guard: { kind: "submission", scope: "web", key: "k" } },
          { key: "submissions/web/gone/1-y", guard: { kind: "submission", scope: "web", key: "gone" } },
        ]),
      ).toEqual(["submissions/web/gone/1-y"]);
      await store.deleteSubmissions([{ scope: "web", key: "k" }]);
      expect(await store.claimUnreferencedStaged([{ key: "submissions/web/k/1-x", guard: { kind: "submission", scope: "web", key: "k" } }])).toEqual([
        "submissions/web/k/1-x",
      ]);
    });

    test(`${name}: submit after retirement returns the original receipt or 409`, async () => {
      const store = make();
      const first = await store.submit(input("retired-key", "digest-a"));
      if (first.outcome !== "stored") throw new Error("expected stored");
      const original = first.submission.confirmationNumber;
      await store.writeReceipts([{ key: "retired-key", scope: "web", confirmationNumber: original, digest: "digest-a", receivedAt: 1000 }]);
      await store.deleteSubmissions([{ scope: "web", key: "retired-key" }]);
      const same = await store.submit(input("retired-key", "digest-a"));
      expect(same.outcome).toBe("duplicate-retired");
      if (same.outcome !== "duplicate-retired") throw new Error("expected duplicate-retired");
      expect(same.receipt.confirmationNumber).toBe(original);
      const changed = await store.submit(input("retired-key", "digest-b", { ...HOUSEHOLD, fullName: "Someone Else" }));
      expect(changed.outcome).toBe("conflict-retired");
      if (changed.outcome !== "conflict-retired") throw new Error("expected conflict-retired");
      expect(changed.receipt.confirmationNumber).toBe(original);
      expect(await store.countSubmissions()).toBe(0);
    });
  }
});
