import type { FileStore } from "../src/files";
import { newConfirmationNumber, type SessionData, type Store, type Submission, type SubmitInput, type SubmitResult } from "../src/store";

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

  async listSubmissions(limit: number): Promise<Submission[]> {
    return [...this.submissions.values()]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit)
      .map((s) => structuredClone(s));
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
