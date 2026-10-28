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

/** What this session already filed, so the review page can say so. */
export interface SubmittedRef {
  key: string;
  confirmationNumber: string;
  digest: string;
  receivedAt: number;
}

export interface SessionData {
  id: string;
  household?: Household;
  files: FileMeta[];
  /** idempotency key minted for this session's submission */
  key: string;
  createdAt: number;
  expiresAt: number;
  submitted?: SubmittedRef;
}

export type SubmissionStatus = "received";

export interface Submission {
  key: string;
  /** "web", or "api-<sha256 of the caller's token>" for JSON callers */
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
  source: "web" | "api";
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
  source: Submission["source"];
  slowMs: number;
  receivedAt: number;
}

export type SubmitResult =
  | { outcome: "stored"; submission: Submission }
  | { outcome: "duplicate"; submission: Submission }
  | { outcome: "conflict"; stored: Submission };

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

export interface Store {
  getSession(id: string): Promise<SessionData | null>;
  putSession(session: SessionData): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Delete timed-out drafts and return them so their file objects go too. */
  deleteExpiredSessions(now: number): Promise<SessionData[]>;
  getSubmission(scope: string, key: string): Promise<Submission | null>;
  listSubmissionSummaries(limit: number, offset: number): Promise<SubmissionSummary[]>;
  countSubmissions(): Promise<number>;
  getReceipt(scope: string, key: string): Promise<SubmissionReceipt | null>;
  /** Retire old submissions to small receipts; returns their file keys for deletion. */
  retireOldSubmissions(olderThan: number): Promise<string[]>;
  purgeOldReceipts(olderThan: number): Promise<number>;
  checkRateLimit(ip: string, now: number, windowMs: number, max: number): Promise<boolean>;
  tryBeginSlow(now: number, ttlMs: number, max: number): Promise<string | null>;
  endSlow(leaseId: string): Promise<void>;
  purgeExpiredSlowLeases(now: number): Promise<void>;
  getSubmissionByConfirmation(confirmation: string): Promise<Submission | null>;
  /**
   * File one submission atomically within its scope. The first writer for a
   * scope and key wins; a later submit under the same scope and key gets the
   * stored winner back (duplicate) or a conflict, never overwrites it.
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
  exec(query: string, ...params: unknown[]): { toArray(): unknown[]; rowsWritten: number };
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

  async deleteExpiredSessions(now: number): Promise<SessionData[]> {
    this.ensureTables();
    const rows = this.sql.exec("SELECT data FROM sessions WHERE expires_at <= ?", now).toArray();
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    return rows.map((row) => JSON.parse((row as { data: string }).data) as SessionData);
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

  async retireOldSubmissions(olderThan: number): Promise<string[]> {
    this.ensureTables();
    const rows = this.sql.exec("SELECT data FROM submissions WHERE received_at < ?", olderThan).toArray();
    const r2keys: string[] = [];
    for (const row of rows) {
      const sub = JSON.parse((row as { data: string }).data) as Submission;
      this.sql.exec(
        "INSERT OR IGNORE INTO receipts (scope, key, confirmation, digest, received_at) VALUES (?, ?, ?, ?, ?)",
        sub.scope,
        sub.key,
        sub.confirmationNumber,
        sub.digest,
        sub.receivedAt,
      );
      for (const file of sub.files) r2keys.push(file.r2key);
    }
    this.sql.exec("DELETE FROM submissions WHERE received_at < ?", olderThan);
    return r2keys;
  }

  async purgeOldReceipts(olderThan: number): Promise<number> {
    this.ensureTables();
    return this.sql.exec("DELETE FROM receipts WHERE received_at < ?", olderThan).rowsWritten;
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
      .exec("SELECT data FROM submissions WHERE confirmation = ?", confirmation)
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
        source: input.source,
      };
      let written: number;
      try {
        written = this.sql.exec(
          "INSERT INTO submissions (scope, key, confirmation, digest, applicant, file_count, data, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope, key) DO NOTHING",
          submission.scope,
          submission.key,
          submission.confirmationNumber,
          submission.digest,
          submission.household.fullName,
          submission.files.length,
          JSON.stringify(submission),
          submission.receivedAt,
        ).rowsWritten;
      } catch (err) {
        // Another row already owns this confirmation number; ours touched nothing.
        if (isConfirmationConflict(err)) continue;
        throw err;
      }
      if (written === 1) return { outcome: "stored", submission };
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
        "SELECT confirmation, applicant, received_at, file_count FROM submissions ORDER BY received_at DESC, scope ASC, key ASC LIMIT ? OFFSET ?",
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
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM submissions").toArray()[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
