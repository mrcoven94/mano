import type { FileStore } from "../src/files";
import {
  API_SCOPE_PREFIX,
  newConfirmationNumber,
  type Draft,
  type SessionData,
  type StagedClaim,
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
    // A copy, like SQL deserializing a fresh row: mutating it without saving changes nothing.
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : null;
  }

  async putSession(session: SessionData): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async renewSession(session: SessionData, now: number): Promise<boolean> {
    // Check and write with no await between, so concurrent callers cannot interleave.
    const current = this.sessions.get(session.id);
    if (!current || current.expiresAt <= now) return false;
    this.sessions.set(session.id, structuredClone(session));
    return true;
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

  async deleteSessionIfExpired(id: string, now: number): Promise<SessionData | null> {
    // Check and delete with no await between, so a renewal cannot slip in.
    const current = this.sessions.get(id);
    if (!current || current.expiresAt > now) return null;
    this.sessions.delete(id);
    return structuredClone(current);
  }

  stagedObjects = new Map<string, number>();

  async trackStaged(entries: StagedEntry[]): Promise<void> {
    for (const entry of entries) this.stagedObjects.set(entry.key, entry.createdAt);
  }

  async untrackStaged(keys: string[]): Promise<void> {
    for (const key of keys) this.stagedObjects.delete(key);
  }

  async listTrackedStaged(): Promise<StagedEntry[]> {
    return [...this.stagedObjects]
      .map(([key, createdAt]) => ({ key, createdAt }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** r2key to (attempt id to hold expiry) */
  filingHolds = new Map<string, Map<string, number>>();
  pendingDeletes = new Set<string>();

  async holdForFiling(attemptId: string, entries: StagedEntry[], until: number): Promise<boolean> {
    // Check and write with no await between, like one Durable Object turn.
    if (entries.some((entry) => this.pendingDeletes.has(entry.key))) return false;
    for (const entry of entries) {
      this.stagedObjects.set(entry.key, entry.createdAt);
      const holds = this.filingHolds.get(entry.key) ?? new Map<string, number>();
      holds.set(attemptId, until);
      this.filingHolds.set(entry.key, holds);
    }
    return true;
  }

  async releaseHolds(attemptId: string): Promise<void> {
    for (const holds of this.filingHolds.values()) holds.delete(attemptId);
  }

  async purgeExpiredHolds(now: number): Promise<void> {
    for (const [key, holds] of this.filingHolds) {
      for (const [attemptId, until] of holds) if (until <= now) holds.delete(attemptId);
      if (holds.size === 0) this.filingHolds.delete(key);
    }
  }

  async claimUnreferencedStaged(claims: StagedClaim[]): Promise<string[]> {
    // Each guard check, untrack and pending record runs with no await between, like one SQL statement.
    const claimed: string[] = [];
    for (const claim of claims) {
      const createdAt = this.stagedObjects.get(claim.key);
      if (createdAt === undefined) continue;
      const guard = claim.guard;
      const held =
        guard.kind === "attempt"
          ? createdAt >= guard.olderThan
          : guard.kind === "session"
            ? (this.sessions.get(guard.sessionId)?.expiresAt ?? 0) > guard.now
            : this.submissions.has(`${guard.scope}\n${guard.key}`) ||
              [...(this.filingHolds.get(claim.key)?.values() ?? [])].some((until) => until > guard.now);
      if (held) continue;
      this.stagedObjects.delete(claim.key);
      this.pendingDeletes.add(claim.key);
      claimed.push(claim.key);
    }
    return claimed;
  }

  async listPendingDeletes(): Promise<string[]> {
    return [...this.pendingDeletes].sort();
  }

  async clearPendingDeletes(keys: string[]): Promise<void> {
    for (const key of keys) this.pendingDeletes.delete(key);
  }

  drafts = new Map<string, Draft>();

  async saveDraft(draft: Draft): Promise<boolean> {
    const current = this.drafts.get(draft.id);
    if (current && current.sessionId !== draft.sessionId && current.expiresAt > draft.savedAt) return false;
    this.drafts.set(draft.id, structuredClone(draft));
    return true;
  }

  async getDraft(id: string, now: number): Promise<Draft | null> {
    const found = this.drafts.get(id);
    return found && found.expiresAt > now ? structuredClone(found) : null;
  }

  async purgeExpiredDrafts(now: number): Promise<number> {
    let purged = 0;
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= now) {
        this.drafts.delete(id);
        purged += 1;
      }
    }
    return purged;
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
    const found = this.byConfirmation.get(confirmation);
    return found?.scope.startsWith(API_SCOPE_PREFIX) ? found : null;
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
    };
    this.submissions.set(scopedKey(submission.scope, submission.key), submission);
    this.byConfirmation.set(submission.confirmationNumber, submission);
    return { outcome: "stored", submission: structuredClone(submission) };
  }

  async listSubmissionSummaries(limit: number, offset: number): Promise<SubmissionSummary[]> {
    return [...this.submissions.values()]
      .filter((s) => s.scope.startsWith(API_SCOPE_PREFIX))
      .sort(
        (a, b) =>
          b.receivedAt - a.receivedAt || (a.scope + a.key < b.scope + b.key ? -1 : a.scope + a.key > b.scope + b.key ? 1 : 0),
      )
      .slice(offset, offset + limit)
      .map((s) => ({ confirmationNumber: s.confirmationNumber, applicant: s.household.fullName, receivedAt: s.receivedAt, fileCount: s.files.length }));
  }

  async countSubmissions(): Promise<number> {
    return [...this.submissions.values()].filter((s) => s.scope.startsWith(API_SCOPE_PREFIX)).length;
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
