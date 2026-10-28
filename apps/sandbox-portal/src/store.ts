export interface Household {
  fullName: string;
  dateOfBirth: string;
  address: string;
  phone: string;
  householdSize: string;
  monthlyIncome: string;
}

export interface StoredFile {
  name: string;
  type: string;
  size: number;
  /** base64-encoded bytes */
  data: string;
}

export interface SessionData {
  id: string;
  household?: Household;
  files: StoredFile[];
  /** idempotency key minted for this session's submission */
  key: string;
  createdAt: number;
  expiresAt: number;
}

export type SubmissionStatus = "received";

export interface Submission {
  key: string;
  confirmationNumber: string;
  household: Household;
  files: StoredFile[];
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
  household: Household;
  files: StoredFile[];
  digest: string;
  source: Submission["source"];
  slowMs: number;
  receivedAt: number;
}

export type SubmitResult =
  | { outcome: "stored"; submission: Submission }
  | { outcome: "duplicate"; submission: Submission }
  | { outcome: "conflict"; stored: Submission };

export interface Store {
  getSession(id: string): Promise<SessionData | null>;
  putSession(session: SessionData): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getSubmission(key: string): Promise<Submission | null>;
  getSubmissionByConfirmation(confirmation: string): Promise<Submission | null>;
  /**
   * File one submission atomically. The first writer for a key wins; a later
   * submit under the same key gets the stored winner back, never overwrites it.
   */
  submit(input: SubmitInput): Promise<SubmitResult>;
  listSubmissions(limit: number): Promise<Submission[]>;
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

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
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

/** Hash the bytes of base64-carried files for the packet digest. */
export async function digestStoredFiles(files: StoredFile[]): Promise<FileDigest[]> {
  const out: FileDigest[] = [];
  for (const f of files) {
    out.push({ name: f.name, type: f.type, size: f.size, sha256: await sha256Hex(fromBase64(f.data)) });
  }
  return out;
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
        key TEXT PRIMARY KEY,
        confirmation TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        data TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_received ON submissions (received_at DESC);
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

  async getSubmission(key: string): Promise<Submission | null> {
    this.ensureTables();
    const row = this.sql
      .exec("SELECT data FROM submissions WHERE key = ?", key)
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

  async submit(input: SubmitInput): Promise<SubmitResult> {
    this.ensureTables();
    for (let attempt = 0; attempt < 10; attempt++) {
      const submission: Submission = {
        key: input.key,
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
          "INSERT INTO submissions (key, confirmation, digest, data, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
          submission.key,
          submission.confirmationNumber,
          submission.digest,
          JSON.stringify(submission),
          submission.receivedAt,
        ).rowsWritten;
      } catch (err) {
        // Another row already owns this confirmation number; ours touched nothing.
        if (isConfirmationConflict(err)) continue;
        throw err;
      }
      if (written === 1) return { outcome: "stored", submission };
      const existing = await this.getSubmission(input.key);
      if (!existing) continue;
      if (existing.digest === input.digest) return { outcome: "duplicate", submission: existing };
      return { outcome: "conflict", stored: existing };
    }
    throw new Error("could not file the submission");
  }

  async listSubmissions(limit: number): Promise<Submission[]> {
    this.ensureTables();
    return this.sql
      .exec("SELECT data FROM submissions ORDER BY received_at DESC LIMIT ?", limit)
      .toArray()
      .map((row) => JSON.parse((row as { data: string }).data) as Submission);
  }
}
