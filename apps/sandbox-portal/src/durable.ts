import { DurableObject } from "cloudflare:workers";
import { PortalStoreSql, type SessionData, type Submission, type SubmitInput, type SubmitResult } from "./store";

/** Durable Object wrapper. All logic lives in PortalStoreSql so unit tests stay runtime-free. */
export class PortalStore extends DurableObject {
  private inner(): PortalStoreSql {
    return new PortalStoreSql(this.ctx.storage.sql);
  }

  getSession(id: string): Promise<SessionData | null> {
    return this.inner().getSession(id);
  }

  putSession(session: SessionData): Promise<void> {
    return this.inner().putSession(session);
  }

  deleteSession(id: string): Promise<void> {
    return this.inner().deleteSession(id);
  }

  getSubmission(scope: string, key: string): Promise<Submission | null> {
    return this.inner().getSubmission(scope, key);
  }

  getSubmissionByConfirmation(confirmation: string): Promise<Submission | null> {
    return this.inner().getSubmissionByConfirmation(confirmation);
  }

  submit(input: SubmitInput): Promise<SubmitResult> {
    return this.inner().submit(input);
  }

  listSubmissions(limit: number): Promise<Submission[]> {
    return this.inner().listSubmissions(limit);
  }
}
