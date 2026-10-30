export interface Household {
  fullName: string;
  dateOfBirth: string;
  address: string;
  phone: string;
  householdSize: string;
  monthlyIncome: string;
}

/** File metadata. Bytes live in the FileStore (R2); SQLite never holds them. */
export interface FileMeta {
  name: string;
  type: string;
  size: number;
  sha256: string;
  r2key: string;
}

export interface SessionData {
  id: string;
  /** The draft this session saves to: caller generated, or minted when the caller gave none. */
  draftId: string;
  household?: Household;
  files: FileMeta[];
  createdAt: number;
  expiresAt: number;
}

/**
 * What the browser saved. A draft is never a filing: only the JSON API with
 * the filing token creates a submission. The agent reads a draft back to
 * compare it with what the person will approve.
 */
export interface Draft {
  id: string;
  /** The session that saved it; another session cannot overwrite it while it lives. */
  sessionId: string;
  household: Household;
  savedAt: number;
  expiresAt: number;
}

/** Every submission scope starts with this; only token holders file. */
export const API_SCOPE_PREFIX = "api-";

export type SubmissionStatus = "received";

export interface Submission {
  key: string;
  /** "api-<sha256 of the caller's token>" */
  scope: string;
  confirmationNumber: string;
  household: Household;
  files: FileMeta[];
  /** SHA-256 of the canonical packet: household fields plus each file's bytes */
  digest: string;
  status: SubmissionStatus;
  receivedAt: number;
  /** response was deliberately held this long (slow mode demo) */
  slowMs: number;
}

/** File identity inside a packet digest. Bytes are hashed, never embedded. */
export interface FileDigest {
  name: string;
  type: string;
  size: number;
  sha256: string;
}

export interface SubmitInput {
  key: string;
  scope: string;
  household: Household;
  files: FileMeta[];
  digest: string;
  slowMs: number;
  receivedAt: number;
}

export type SubmitResult =
  | { outcome: "stored"; submission: Submission }
  | { outcome: "duplicate"; submission: Submission }
  | { outcome: "duplicate-retired"; receipt: SubmissionReceipt }
  | { outcome: "conflict"; stored: Submission }
  | { outcome: "conflict-retired"; receipt: SubmissionReceipt };

/** Small receipt kept after the full submission is retired. */
export interface SubmissionReceipt {
  key: string;
  scope: string;
  confirmationNumber: string;
  digest: string;
  receivedAt: number;
}

/** One row of the caseworker list. Metadata only, never file bytes. */
export interface SubmissionSummary {
  confirmationNumber: string;
  applicant: string;
  receivedAt: number;
  fileCount: number;
}

export interface StagedEntry {
  key: string;
  createdAt: number;
}

/**
 * Why a tracked object may be deleted. Attempt staging belongs to no
 * session, so age alone guards it; drafts live while their session does;
 * filed copies live while a submission row or an in-flight filing hold
 * references them, whatever their age.
 */
export type StagedGuard =
  | { kind: "attempt"; olderThan: number }
  | { kind: "session"; sessionId: string; now: number }
  | { kind: "submission"; scope: string; key: string; now: number };

export interface StagedClaim {
  key: string;
  guard: StagedGuard;
}

export interface Store {
  getSession(id: string): Promise<SessionData | null>;
  putSession(session: SessionData): Promise<void>;
  /**
   * Renew a session only if it is still unexpired, checked in the same
   * statement as the write. False means the session lapsed mid-request
   * (or the sweep reaped it) and the caller must treat it as expired.
   */
  renewSession(session: SessionData, now: number): Promise<boolean>;
  deleteSession(id: string): Promise<void>;
  /** Timed-out drafts, listed without deleting so R2 goes first and rows after. */
  listExpiredSessions(now: number): Promise<SessionData[]>;
  /**
   * Delete one session only if it is still expired, checked in the same
   * statement as the delete. A renewal that lands after the listing wins,
   * and the sweep leaves that session alone.
   */
  deleteSessionIfExpired(id: string, now: number): Promise<SessionData | null>;
  getSubmission(scope: string, key: string): Promise<Submission | null>;
  /** Caseworker reads see API-scope rows only; nothing else is a filing. */
  listSubmissionSummaries(limit: number, offset: number): Promise<SubmissionSummary[]>;
  countSubmissions(): Promise<number>;
  getReceipt(scope: string, key: string): Promise<SubmissionReceipt | null>;
  /** Old submissions, listed without deleting so receipts and R2 go first. */
  listOldSubmissions(olderThan: number, limit: number): Promise<Submission[]>;
  writeReceipts(receipts: SubmissionReceipt[]): Promise<void>;
  deleteSubmissions(keys: Array<{ scope: string; key: string }>): Promise<void>;
  purgeOldReceipts(olderThan: number): Promise<number>;
  /** Record staged objects; the record clears only after the R2 delete succeeds. */
  trackStaged(entries: StagedEntry[]): Promise<void>;
  untrackStaged(keys: string[]): Promise<void>;
  listTrackedStaged(): Promise<StagedEntry[]>;
  /**
   * Track one filing attempt's destination keys and hold them until the
   * attempt releases them or the hold expires, so the sweep cannot take a
   * copy before its submission row exists. False, with nothing written, when
   * any key still waits on an R2 delete: writing it now could lose to that delete.
   */
  holdForFiling(attemptId: string, entries: StagedEntry[], until: number): Promise<boolean>;
  releaseHolds(attemptId: string): Promise<void>;
  purgeExpiredHolds(now: number): Promise<void>;
  /**
   * Untrack each claimed key only if its guard holds, checked in the same
   * statement as the delete, and record it as a pending delete in the same
   * turn. Returns the newly claimed keys. A renewal or hold that lands first
   * keeps the object referenced, so the claim fails and the bytes stay.
   */
  claimUnreferencedStaged(claims: StagedClaim[]): Promise<string[]>;
  /** Claimed keys whose R2 delete has not been confirmed yet. */
  listPendingDeletes(): Promise<string[]>;
  /** Call only after R2 confirmed the delete. */
  clearPendingDeletes(keys: string[]): Promise<void>;
  /**
   * Save a draft unless another session owns a live draft under the same id,
   * checked in the same statement as the write. False means refused.
   */
  saveDraft(draft: Draft): Promise<boolean>;
  /** A draft that has not expired, or null. */
  getDraft(id: string, now: number): Promise<Draft | null>;
  purgeExpiredDrafts(now: number): Promise<number>;
  checkRateLimit(ip: string, now: number, windowMs: number, max: number): Promise<boolean>;
  tryBeginSlow(now: number, ttlMs: number, max: number): Promise<string | null>;
  endSlow(leaseId: string): Promise<void>;
  purgeExpiredSlowLeases(now: number): Promise<void>;
  getSubmissionByConfirmation(confirmation: string): Promise<Submission | null>;
  /**
   * File one submission atomically within its scope. The first writer for a
   * scope and key wins; a later submit under the same scope and key gets the
   * stored winner back (duplicate) or a conflict, never overwrites it. After
   * the submission retires, the retained receipt answers the same way.
   */
  submit(input: SubmitInput): Promise<SubmitResult>;
}

const CONFIRM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newConfirmationNumber(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = [...buf].map((b) => CONFIRM_ALPHABET[b % CONFIRM_ALPHABET.length]);
  return `SR-${chars.join("")}`;
}

function isConfirmationConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("submissions.confirmation");
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical packet encoding. Field order is fixed so equal packets digest equally. */
export function canonicalPacket(household: Household, files: FileDigest[]): string {
  return JSON.stringify({
    household: {
      address: household.address,
      dateOfBirth: household.dateOfBirth,
      fullName: household.fullName,
      householdSize: household.householdSize,
      monthlyIncome: household.monthlyIncome,
      phone: household.phone,
    },
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.size, sha256: f.sha256 })),
  });
}

export async function packetDigest(household: Household, files: FileDigest[]): Promise<string> {
  return sha256Hex(canonicalPacket(household, files));
}

export function metasToDigests(files: FileMeta[]): FileDigest[] {
  return files.map((f) => ({ name: f.name, type: f.type, size: f.size, sha256: f.sha256 }));
}

/** Minimal surface of Durable Object SQLite storage, so tests never import cloudflare:workers. */
export interface SqlStorage {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

export class PortalStoreSql implements Store {
  private sql: SqlStorage;
  private ready = false;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  private ensureTables(): void {
    if (this.ready) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        confirmation TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        applicant TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        data TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_received ON submissions (received_at DESC);
      CREATE TABLE IF NOT EXISTS rate_buckets (
        ip TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slow_leases (
        id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        confirmation TEXT NOT NULL,
        digest TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS staged_objects (
        r2key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS filing_holds (
        r2key TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (r2key, attempt_id)
      );
      CREATE TABLE IF NOT EXISTS pending_deletes (
        r2key TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.ready = true;
  }

  async getSession(id: string): Promise<SessionData | null> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT data FROM sessions WHERE id = ?", id)
      .toArray()[0] as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SessionData) : null;
  }

  async putSession(session: SessionData): Promise<void> {
    this.ensureTables();
    this.sql.exec(
      "INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)",
      session.id,
      JSON.stringify(session),
      session.expiresAt,
    );
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureTables();
    this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
  }

  async renewSession(session: SessionData, now: number): Promise<boolean> {
    this.ensureTables();
    return (
      this.sql.exec("UPDATE sessions SET data = ?, expires_at = ? WHERE id = ? AND expires_at > ? RETURNING id", JSON.stringify(session), session.expiresAt, session.id, now).toArray()
        .length === 1
    );
  }

  async listExpiredSessions(now: number): Promise<SessionData[]> {
    this.ensureTables();
    return this.sql
      .exec("SELECT data FROM sessions WHERE expires_at <= ?", now)
      .toArray()
      .map((row) => JSON.parse((row as { data: string }).data) as SessionData);
  }

  async deleteSessionIfExpired(id: string, now: number): Promise<SessionData | null> {
    this.ensureTables();
    const row = this.sql.exec("DELETE FROM sessions WHERE id = ? AND expires_at <= ? RETURNING data", id, now).toArray()[0] as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as SessionData) : null;
  }

  async trackStaged(entries: StagedEntry[]): Promise<void> {
    this.ensureTables();
    for (const entry of entries) {
      this.sql.exec("INSERT OR REPLACE INTO staged_objects (r2key, created_at) VALUES (?, ?)", entry.key, entry.createdAt);
    }
  }

  async untrackStaged(keys: string[]): Promise<void> {
    this.ensureTables();
    for (const key of keys) this.sql.exec("DELETE FROM staged_objects WHERE r2key = ?", key);
  }

  async listTrackedStaged(): Promise<StagedEntry[]> {
    this.ensureTables();
    return this.sql
      .exec("SELECT r2key, created_at FROM staged_objects ORDER BY r2key")
      .toArray()
      .map((row) => {
        const r = row as { r2key: string; created_at: number };
        return { key: r.r2key, createdAt: r.created_at };
      });
  }

  async holdForFiling(attemptId: string, entries: StagedEntry[], until: number): Promise<boolean> {
    this.ensureTables();
    // No await between these statements: the Durable Object commits them as one turn.
    for (const entry of entries) {
      if (this.sql.exec("SELECT 1 FROM pending_deletes WHERE r2key = ?", entry.key).toArray().length > 0) return false;
    }
    for (const entry of entries) {
      this.sql.exec("INSERT OR REPLACE INTO staged_objects (r2key, created_at) VALUES (?, ?)", entry.key, entry.createdAt);
      this.sql.exec("INSERT OR REPLACE INTO filing_holds (r2key, attempt_id, expires_at) VALUES (?, ?, ?)", entry.key, attemptId, until);
    }
    return true;
  }

  async releaseHolds(attemptId: string): Promise<void> {
    this.ensureTables();
    this.sql.exec("DELETE FROM filing_holds WHERE attempt_id = ?", attemptId);
  }

  async purgeExpiredHolds(now: number): Promise<void> {
    this.ensureTables();
    this.sql.exec("DELETE FROM filing_holds WHERE expires_at <= ?", now);
  }

  async claimUnreferencedStaged(claims: StagedClaim[]): Promise<string[]> {
    this.ensureTables();
    const claimed: string[] = [];
    for (const claim of claims) {
      let rows: unknown[];
      if (claim.guard.kind === "attempt") {
        rows = this.sql.exec("DELETE FROM staged_objects WHERE r2key = ? AND created_at < ? RETURNING r2key", claim.key, claim.guard.olderThan).toArray();
      } else if (claim.guard.kind === "session") {
        rows = this.sql.exec(
          "DELETE FROM staged_objects WHERE r2key = ? AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?) RETURNING r2key",
          claim.key,
          claim.guard.sessionId,
          claim.guard.now,
        ).toArray();
      } else {
        rows = this.sql.exec(
          "DELETE FROM staged_objects WHERE r2key = ? AND NOT EXISTS (SELECT 1 FROM submissions WHERE scope = ? AND key = ?) AND NOT EXISTS (SELECT 1 FROM filing_holds WHERE r2key = ? AND expires_at > ?) RETURNING r2key",
          claim.key,
          claim.guard.scope,
          claim.guard.key,
          claim.key,
          claim.guard.now,
        ).toArray();
      }
      if (rows.length === 1) {
        // Same turn as the untrack, so the object is never unrecorded before R2 confirms its delete.
        this.sql.exec("INSERT OR IGNORE INTO pending_deletes (r2key) VALUES (?)", claim.key);
        claimed.push(claim.key);
      }
    }
    return claimed;
  }

  async listPendingDeletes(): Promise<string[]> {
    this.ensureTables();
    return this.sql
      .exec("SELECT r2key FROM pending_deletes ORDER BY r2key")
      .toArray()
      .map((row) => (row as { r2key: string }).r2key);
  }

  async clearPendingDeletes(keys: string[]): Promise<void> {
    this.ensureTables();
    for (const key of keys) this.sql.exec("DELETE FROM pending_deletes WHERE r2key = ?", key);
  }

  async saveDraft(draft: Draft): Promise<boolean> {
    this.ensureTables();
    return (
      this.sql
        .exec(
          `INSERT INTO drafts (id, session_id, data, saved_at, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, data = excluded.data, saved_at = excluded.saved_at, expires_at = excluded.expires_at
           WHERE drafts.session_id = excluded.session_id OR drafts.expires_at <= excluded.saved_at
           RETURNING id`,
          draft.id,
          draft.sessionId,
          JSON.stringify(draft.household),
          draft.savedAt,
          draft.expiresAt,
        )
        .toArray().length === 1
    );
  }

  async getDraft(id: string, now: number): Promise<Draft | null> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT id, session_id, data, saved_at, expires_at FROM drafts WHERE id = ? AND expires_at > ?", id, now)
      .toArray()[0] as { id: string; session_id: string; data: string; saved_at: number; expires_at: number } | undefined;
    return row
      ? { id: row.id, sessionId: row.session_id, household: JSON.parse(row.data) as Household, savedAt: row.saved_at, expiresAt: row.expires_at }
      : null;
  }

  async purgeExpiredDrafts(now: number): Promise<number> {
    this.ensureTables();
    return this.sql.exec("DELETE FROM drafts WHERE expires_at <= ? RETURNING id", now).toArray().length;
  }

  async getReceipt(scope: string, key: string): Promise<SubmissionReceipt | null> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT key, scope, confirmation, digest, received_at FROM receipts WHERE scope = ? AND key = ?", scope, key)
      .toArray()[0] as
      | { key: string; scope: string; confirmation: string; digest: string; received_at: number }
      | undefined;
    return row
      ? { key: row.key, scope: row.scope, confirmationNumber: row.confirmation, digest: row.digest, receivedAt: row.received_at }
      : null;
  }

  async listOldSubmissions(olderThan: number, limit: number): Promise<Submission[]> {
    this.ensureTables();
    return this.sql
      .exec("SELECT data FROM submissions WHERE received_at < ? LIMIT ?", olderThan, limit)
      .toArray()
      .map((row) => JSON.parse((row as { data: string }).data) as Submission);
  }

  async writeReceipts(receipts: SubmissionReceipt[]): Promise<void> {
    this.ensureTables();
    for (const receipt of receipts) {
      this.sql.exec(
        "INSERT OR IGNORE INTO receipts (scope, key, confirmation, digest, received_at) VALUES (?, ?, ?, ?, ?)",
        receipt.scope,
        receipt.key,
        receipt.confirmationNumber,
        receipt.digest,
        receipt.receivedAt,
      );
    }
  }

  async deleteSubmissions(keys: Array<{ scope: string; key: string }>): Promise<void> {
    this.ensureTables();
    for (const { scope, key } of keys) this.sql.exec("DELETE FROM submissions WHERE scope = ? AND key = ?", scope, key);
  }

  async purgeOldReceipts(olderThan: number): Promise<number> {
    this.ensureTables();
    return this.sql.exec("DELETE FROM receipts WHERE received_at < ? RETURNING key", olderThan).toArray().length;
  }

  async getSubmission(scope: string, key: string): Promise<Submission | null> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT data FROM submissions WHERE scope = ? AND key = ?", scope, key)
      .toArray()[0] as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Submission) : null;
  }

  async getSubmissionByConfirmation(confirmation: string): Promise<Submission | null> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT data FROM submissions WHERE confirmation = ? AND scope LIKE ?", confirmation, `${API_SCOPE_PREFIX}%`)
      .toArray()[0] as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Submission) : null;
  }

  async checkRateLimit(ip: string, now: number, windowMs: number, max: number): Promise<boolean> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT window_start, count FROM rate_buckets WHERE ip = ?", ip)
      .toArray()[0] as { window_start: number; count: number } | undefined;
    if (!row || row.window_start + windowMs <= now) {
      this.sql.exec("INSERT OR REPLACE INTO rate_buckets (ip, window_start, count) VALUES (?, ?, 1)", ip, now);
      return true;
    }
    if (row.count >= max) return false;
    this.sql.exec("UPDATE rate_buckets SET count = count + 1 WHERE ip = ?", ip);
    return true;
  }

  async tryBeginSlow(now: number, ttlMs: number, max: number): Promise<string | null> {
    this.ensureTables();
    this.sql.exec("DELETE FROM slow_leases WHERE expires_at <= ?", now);
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM slow_leases").toArray()[0] as { n: number } | undefined;
    if ((row?.n ?? 0) >= max) return null;
    const id = newId(8);
    this.sql.exec("INSERT INTO slow_leases (id, expires_at) VALUES (?, ?)", id, now + ttlMs);
    return id;
  }

  async endSlow(leaseId: string): Promise<void> {
    this.ensureTables();
    this.sql.exec("DELETE FROM slow_leases WHERE id = ?", leaseId);
  }

  async purgeExpiredSlowLeases(now: number): Promise<void> {
    this.ensureTables();
    this.sql.exec("DELETE FROM slow_leases WHERE expires_at <= ?", now);
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    this.ensureTables();
    const live = await this.getSubmission(input.scope, input.key);
    if (live) {
      if (live.digest === input.digest) return { outcome: "duplicate", submission: live };
      return { outcome: "conflict", stored: live };
    }
    // A retired key keeps its idempotency: the retained receipt answers.
    const receipt = await this.getReceipt(input.scope, input.key);
    if (receipt) {
      if (receipt.digest === input.digest) return { outcome: "duplicate-retired", receipt };
      return { outcome: "conflict-retired", receipt };
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const submission: Submission = {
        key: input.key,
        scope: input.scope,
        confirmationNumber: newConfirmationNumber(),
        household: input.household,
        files: input.files,
        digest: input.digest,
        status: "received",
        receivedAt: input.receivedAt,
        slowMs: input.slowMs,
      };
      let inserted: unknown[];
      try {
        // RETURNING reports the insert; a conflicting key returns no row.
        inserted = this.sql.exec(
          "INSERT INTO submissions (scope, key, confirmation, digest, applicant, file_count, data, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope, key) DO NOTHING RETURNING confirmation",
          submission.scope,
          submission.key,
          submission.confirmationNumber,
          submission.digest,
          submission.household.fullName,
          submission.files.length,
          JSON.stringify(submission),
          submission.receivedAt,
        ).toArray();
      } catch (err) {
        // Another row already owns this confirmation number; ours touched nothing.
        if (isConfirmationConflict(err)) continue;
        throw err;
      }
      if (inserted.length === 1) {
        // A retire that landed between our receipt check and this insert owns
        // the key; yield to it instead of filing a second confirmation.
        const raced = await this.getReceipt(input.scope, input.key);
        if (raced) {
          await this.deleteSubmissions([{ scope: input.scope, key: input.key }]);
          if (raced.digest === input.digest) return { outcome: "duplicate-retired", receipt: raced };
          return { outcome: "conflict-retired", receipt: raced };
        }
        return { outcome: "stored", submission };
      }
      const existing = await this.getSubmission(input.scope, input.key);
      if (!existing) continue;
      if (existing.digest === input.digest) return { outcome: "duplicate", submission: existing };
      return { outcome: "conflict", stored: existing };
    }
    throw new Error("could not file the submission");
  }

  async listSubmissionSummaries(limit: number, offset: number): Promise<SubmissionSummary[]> {
    this.ensureTables();
    return this.sql
      .exec(
        "SELECT confirmation, applicant, received_at, file_count FROM submissions WHERE scope LIKE ? ORDER BY received_at DESC, scope ASC, key ASC LIMIT ? OFFSET ?",
        `${API_SCOPE_PREFIX}%`,
        limit,
        offset,
      )
      .toArray()
      .map((row) => {
        const r = row as { confirmation: string; applicant: string; received_at: number; file_count: number };
        return { confirmationNumber: r.confirmation, applicant: r.applicant, receivedAt: r.received_at, fileCount: r.file_count };
      });
  }

  async countSubmissions(): Promise<number> {
    this.ensureTables();
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM submissions WHERE scope LIKE ?", `${API_SCOPE_PREFIX}%`).toArray()[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
