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
  status: SubmissionStatus;
  receivedAt: number;
  /** response was deliberately held this long (slow mode demo) */
  slowMs: number;
  source: "web" | "api";
}

export interface Store {
  getSession(id: string): Promise<SessionData | null>;
  putSession(session: SessionData): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getSubmission(key: string): Promise<Submission | null>;
  getSubmissionByConfirmation(confirmation: string): Promise<Submission | null>;
  putSubmission(submission: Submission): Promise<void>;
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

export async function uniqueConfirmationNumber(store: Store): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = newConfirmationNumber();
    if ((await store.getSubmissionByConfirmation(candidate)) === null) return candidate;
  }
  throw new Error("could not mint a unique confirmation number");
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
        key TEXT PRIMARY KEY,
        confirmation TEXT NOT NULL UNIQUE,
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

  async putSubmission(submission: Submission): Promise<void> {
    this.ensureTables();
    this.sql.exec(
      "INSERT OR REPLACE INTO submissions (key, confirmation, data, received_at) VALUES (?, ?, ?, ?)",
      submission.key,
      submission.confirmationNumber,
      JSON.stringify(submission),
      submission.receivedAt,
    );
  }

  async listSubmissions(limit: number): Promise<Submission[]> {
    this.ensureTables();
    return this.sql
      .exec("SELECT data FROM submissions ORDER BY received_at DESC LIMIT ?", limit)
      .toArray()
      .map((row) => JSON.parse((row as { data: string }).data) as Submission);
  }
}
