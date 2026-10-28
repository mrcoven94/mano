import { newConfirmationNumber, type SessionData, type Store, type Submission, type SubmitInput, type SubmitResult } from "../src/store";

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

  async getSubmission(key: string): Promise<Submission | null> {
    return this.submissions.get(key) ?? null;
  }

  async getSubmissionByConfirmation(confirmation: string): Promise<Submission | null> {
    return this.byConfirmation.get(confirmation) ?? null;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    // Check and insert with no await between, so concurrent callers cannot interleave.
    const existing = this.submissions.get(input.key);
    if (existing) return { outcome: "duplicate", submission: structuredClone(existing) };
    let confirmationNumber = newConfirmationNumber();
    while (this.byConfirmation.has(confirmationNumber)) confirmationNumber = newConfirmationNumber();
    const submission: Submission = {
      key: input.key,
      confirmationNumber,
      household: structuredClone(input.household),
      files: structuredClone(input.files),
      status: "received",
      receivedAt: input.receivedAt,
      slowMs: input.slowMs,
      source: input.source,
    };
    this.submissions.set(submission.key, submission);
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
