import type { SessionData, Store, Submission } from "../src/store";

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

  async putSubmission(submission: Submission): Promise<void> {
    const copy = structuredClone(submission);
    this.submissions.set(copy.key, copy);
    this.byConfirmation.set(copy.confirmationNumber, copy);
  }

  async listSubmissions(limit: number): Promise<Submission[]> {
    return [...this.submissions.values()]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }
}
