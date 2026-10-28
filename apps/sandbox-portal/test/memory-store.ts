import type { FileStore } from "../src/files";
import {
  newConfirmationNumber,
  type SessionData,
  type StagedEntry,
  type Store,
  type Submission,
  type SubmissionReceipt,
  type SubmissionSummary,
  type SubmitInput,
  type SubmitResult,
} from "../src/store";

function scopedKey(scope: string, key: string): string {
  return `${scope}
${key}`;
}

/** In-memory Store for tests and local contributors without wrangler. */
export class MemoryStore implements Store {
  sessions = new Map<string, SessionData>();
  submissions = new Map<string, Submission>();
  byConfirmation = new Map<string, Submission>();

  async getSession(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async putSession(session: SessionData): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async listExpiredSessions(now: number): Promise<SessionData[]> {
    const expired: SessionData[] = [];
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now) expired.push(structuredClone(session));
    }
    return expired;
  }

  async deleteSessions(ids: string[]): Promise<void> {
    for (const id of ids) this.sessions.delete(id);
  }

  stagedObjects = new Map<string, number>();

  async trackStaged(entries: StagedEntry[]): Promise<void> {
    for (const entry of entries) this.stagedObjects.set(entry.key, entry.createdAt);
  }

  async untrackStaged(keys: string[]): Promise<void> {
    for (const key of keys) this.stagedObjects.delete(key);
  }

  async listStaleStaged(olderThan: number): Promise<string[]> {
    const stale: string[] = [];
    for (const [key, createdAt] of this.stagedObjects) {
      if (createdAt < olderThan) stale.push(key);
    }
    return stale;
  }

  receipts = new Map<string, SubmissionReceipt>();

  async getReceipt(scope: string, key: string): Promise<SubmissionReceipt | null> {
    return this.receipts.get(scopedKey(scope, key)) ?? null;
  }

  async listOldSubmissions(olderThan: number, limit: number): Promise<Submission[]> {
    return [...this.submissions.values()]
      .filter((sub) => sub.receivedAt < olderThan)
      .slice(0, limit)
      .map((sub) => structuredClone(sub));
  }

  async writeReceipts(receipts: SubmissionReceipt[]): Promise<void> {
    for (const receipt of receipts) {
      const mapKey = scopedKey(receipt.scope, receipt.key);
      if (!this.receipts.has(mapKey)) this.receipts.set(mapKey, structuredClone(receipt));
    }
  }

  async deleteSubmissions(keys: Array<{ scope: string; key: string }>): Promise<void> {
    for (const { scope, key } of keys) {
      const sub = this.submissions.get(scopedKey(scope, key));
      if (sub) {
        this.submissions.delete(scopedKey(scope, key));
        this.byConfirmation.delete(sub.confirmationNumber);
      }
    }
  }

  async purgeOldReceipts(olderThan: number): Promise<number> {
    let purged = 0;
    for (const [mapKey, receipt] of this.receipts) {
      if (receipt.receivedAt < olderThan) {
        this.receipts.delete(mapKey);
        purged += 1;
      }
    }
    return purged;
  }

  async getSubmission(scope: string, key: string): Promise<Submission | null> {
    return this.submissions.get(scopedKey(scope, key)) ?? null;
  }

  async getSubmissionByConfirmation(confirmation: string): Promise<Submission | null> {
    return this.byConfirmation.get(confirmation) ?? null;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    // Check and insert with no await between, so concurrent callers cannot interleave.
    const existing = this.submissions.get(scopedKey(input.scope, input.key));
    if (existing) {
      if (existing.digest === input.digest) return { outcome: "duplicate", submission: structuredClone(existing) };
      return { outcome: "conflict", stored: structuredClone(existing) };
    }
    const receipt = this.receipts.get(scopedKey(input.scope, input.key));
    if (receipt) {
      if (receipt.digest === input.digest) return { outcome: "duplicate-retired", receipt: structuredClone(receipt) };
      return { outcome: "conflict-retired", receipt: structuredClone(receipt) };
    }
    let confirmationNumber = newConfirmationNumber();
    while (this.byConfirmation.has(confirmationNumber)) confirmationNumber = newConfirmationNumber();
    const submission: Submission = {
      key: input.key,
      scope: input.scope,
      confirmationNumber,
      household: structuredClone(input.household),
      files: structuredClone(input.files),
      digest: input.digest,
      status: "received",
      receivedAt: input.receivedAt,
      slowMs: input.slowMs,
      source: input.source,
    };
    this.submissions.set(scopedKey(submission.scope, submission.key), submission);
    this.byConfirmation.set(submission.confirmationNumber, submission);
    return { outcome: "stored", submission: structuredClone(submission) };
  }

  async listSubmissionSummaries(limit: number, offset: number): Promise<SubmissionSummary[]> {
    return [...this.submissions.values()]
      .sort(
        (a, b) =>
          b.receivedAt - a.receivedAt || (a.scope + a.key < b.scope + b.key ? -1 : a.scope + a.key > b.scope + b.key ? 1 : 0),
      )
      .slice(offset, offset + limit)
      .map((s) => ({ confirmationNumber: s.confirmationNumber, applicant: s.household.fullName, receivedAt: s.receivedAt, fileCount: s.files.length }));
  }

  async countSubmissions(): Promise<number> {
    return this.submissions.size;
  }

  rateBuckets = new Map<string, { windowStart: number; count: number }>();
  slowLeases = new Map<string, number>();

  async checkRateLimit(ip: string, now: number, windowMs: number, max: number): Promise<boolean> {
    const row = this.rateBuckets.get(ip);
    if (!row || row.windowStart + windowMs <= now) {
      this.rateBuckets.set(ip, { windowStart: now, count: 1 });
      return true;
    }
    if (row.count >= max) return false;
    row.count += 1;
    return true;
  }

  async tryBeginSlow(now: number, ttlMs: number, max: number): Promise<string | null> {
    for (const [id, expiresAt] of this.slowLeases) {
      if (expiresAt <= now) this.slowLeases.delete(id);
    }
    if (this.slowLeases.size >= max) return null;
    const id = newConfirmationNumber();
    this.slowLeases.set(id, now + ttlMs);
    return id;
  }

  async endSlow(leaseId: string): Promise<void> {
    this.slowLeases.delete(leaseId);
  }

  async purgeExpiredSlowLeases(now: number): Promise<void> {
    for (const [id, expiresAt] of this.slowLeases) {
      if (expiresAt <= now) this.slowLeases.delete(id);
    }
  }
}

/** In-memory FileStore for tests. */
export class MemoryFileStore implements FileStore {
  objects = new Map<string, { data: Uint8Array; type: string }>();

  async put(key: string, data: Uint8Array, type: string): Promise<void> {
    this.objects.set(key, { data: new Uint8Array(data), type });
  }

  async get(key: string): Promise<{ data: Uint8Array; type: string } | null> {
    const found = this.objects.get(key);
    return found ? { data: new Uint8Array(found.data), type: found.type } : null;
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}
