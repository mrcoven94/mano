import { DurableObject } from "cloudflare:workers";
import {
  PortalStoreSql,
  type SessionData,
  type StagedEntry,
  type Submission,
  type SubmissionReceipt,
  type SubmissionSummary,
  type SubmitInput,
  type SubmitResult,
} from "./store";

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

  listExpiredSessions(now: number): Promise<SessionData[]> {
    return this.inner().listExpiredSessions(now);
  }

  deleteSessions(ids: string[]): Promise<void> {
    return this.inner().deleteSessions(ids);
  }

  trackStaged(entries: StagedEntry[]): Promise<void> {
    return this.inner().trackStaged(entries);
  }

  untrackStaged(keys: string[]): Promise<void> {
    return this.inner().untrackStaged(keys);
  }

  listStaleStaged(olderThan: number): Promise<string[]> {
    return this.inner().listStaleStaged(olderThan);
  }

  getReceipt(scope: string, key: string): Promise<SubmissionReceipt | null> {
    return this.inner().getReceipt(scope, key);
  }

  listOldSubmissions(olderThan: number, limit: number): Promise<Submission[]> {
    return this.inner().listOldSubmissions(olderThan, limit);
  }

  writeReceipts(receipts: SubmissionReceipt[]): Promise<void> {
    return this.inner().writeReceipts(receipts);
  }

  deleteSubmissions(keys: Array<{ scope: string; key: string }>): Promise<void> {
    return this.inner().deleteSubmissions(keys);
  }

  purgeOldReceipts(olderThan: number): Promise<number> {
    return this.inner().purgeOldReceipts(olderThan);
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

  checkRateLimit(ip: string, now: number, windowMs: number, max: number): Promise<boolean> {
    return this.inner().checkRateLimit(ip, now, windowMs, max);
  }

  tryBeginSlow(now: number, ttlMs: number, max: number): Promise<string | null> {
    return this.inner().tryBeginSlow(now, ttlMs, max);
  }

  endSlow(leaseId: string): Promise<void> {
    return this.inner().endSlow(leaseId);
  }

  purgeExpiredSlowLeases(now: number): Promise<void> {
    return this.inner().purgeExpiredSlowLeases(now);
  }

  listSubmissionSummaries(limit: number, offset: number): Promise<SubmissionSummary[]> {
    return this.inner().listSubmissionSummaries(limit, offset);
  }

  countSubmissions(): Promise<number> {
    return this.inner().countSubmissions();
  }
}
