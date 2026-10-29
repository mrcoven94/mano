// Accounts service: one person, one Mano account.
// Text first creates the account. Web and app sign in with phone codes
// or WorkOS AuthKit email, then exchange for an engine session.
// Linking adds a verified handle. Merging moves conversation, documents,
// approvals and consents only after both sides are verified in the same
// session and the person confirms the exact combine text. Never merges silently.

import { CODE_TTL_MS, PhoneCodeService } from "./codes";
import { keyedHash } from "./crypto";
import type { ChannelsPort } from "./channels";
import type { EngineAccountsPort } from "./engine";
import { parseSessionExpiry } from "./engine";
import { IdentityConflictError, PersonStore } from "./store";
import { maskEmail, maskPhone, maskWorkosUserId, normalizeEmail, normalizePhone } from "./normalize";
import type { AccountView, MaskedIdentity, MergePreview } from "./types";
import type { WorkOSAuthOptions, WorkOSPort } from "./workos";

export interface ServiceConfig {
  store: PersonStore;
  codes: PhoneCodeService;
  workos: WorkOSPort;
  engine: EngineAccountsPort;
  channels: ChannelsPort;
  pepper: string;
  now?: () => number;
}

interface SessionRow {
  token: string;
  personId: string;
  createdAt: number;
}

interface LinkProof {
  sessionToken: string;
  verifiedPersonId: string;
  at: number;
}

interface MergePreviewRow {
  id: string;
  fromPersonId: string;
  intoPersonId: string;
  sessionToken: string;
  createdAt: number;
  preview: MergePreview;
}

export interface MergeJob {
  key: string;
  fromPersonId: string;
  intoPersonId: string;
  sessionToken: string;
  previewId: string;
  moved: MergePreview["moved"];
  state: "engine-move" | "store-merge" | "finish" | "done";
  updatedAt: number;
}

export interface DeleteJob {
  id: string;
  personId: string;
  engineDone: boolean;
  channelsDone: boolean;
  storeDone: boolean;
  attempts: number;
  lastError: string | null;
  updatedAt: number;
}

export class DeleteIncompleteError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super("Delete did not finish. It is saved and will retry.");
    this.name = "DeleteIncompleteError";
    this.jobId = jobId;
  }
}

const LINK_PROOF_TTL_MS = 30 * 60 * 1000;
const MERGE_PREVIEW_TTL_MS = 15 * 60 * 1000;
const FRESH_PHONE_MS = 10 * 60 * 1000;

export class AccountsService {
  private store: PersonStore;
  private codes: PhoneCodeService;
  private workos: WorkOSPort;
  private engine: EngineAccountsPort;
  private channels: ChannelsPort;
  private pepper: string;
  private now: () => number;
  private sessions = new Map<string, SessionRow>();
  private linkProofs: LinkProof[] = [];
  private phoneVerifiedAt = new Map<string, number>();
  private mergePreviews = new Map<string, MergePreviewRow>();
  private mergeJobs = new Map<string, MergeJob>();
  private deleteJobs = new Map<string, DeleteJob>();
  private previewSeq = 1;
  private jobSeq = 1;

  constructor(config: ServiceConfig) {
    this.store = config.store;
    this.codes = config.codes;
    this.workos = config.workos;
    this.engine = config.engine;
    this.channels = config.channels;
    this.pepper = config.pepper;
    this.now = config.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private async phoneHash(e164: string): Promise<string> {
    return keyedHash(e164, this.pepper, "mano-phone-code-target:v1");
  }

  private sessionPerson(token: string): string {
    const row = this.sessions.get(token);
    if (!row) throw new Error("Signed out. Sign in again.");
    // Engine tokens carry their own expiry; stand-in tokens carry none and
    // only exist outside production. Expired engine sessions stop here.
    const exp = parseSessionExpiry(token);
    if (exp !== null && exp <= this.now()) {
      this.sessions.delete(token);
      throw new Error("Signed out. Sign in again.");
    }
    return row.personId;
  }

  private rememberSession(token: string, personId: string): void {
    this.sessions.set(token, { token, personId, createdAt: this.now() });
  }

  private addLinkProof(sessionToken: string, verifiedPersonId: string): void {
    this.linkProofs.push({ sessionToken, verifiedPersonId, at: this.now() });
  }

  private hasLinkProof(sessionToken: string, verifiedPersonId: string): boolean {
    const now = this.now();
    return this.linkProofs.some(
      (p) => p.sessionToken === sessionToken && p.verifiedPersonId === verifiedPersonId && p.at + LINK_PROOF_TTL_MS > now,
    );
  }

  // Freshness is per session: a code verified in one session never satisfies
  // another, even for the same person.
  private freshKey(sessionToken: string, personId: string, phoneHash: string): string {
    return `${sessionToken}:${personId}:${phoneHash}`;
  }

  private async markPhoneFresh(sessionToken: string, personId: string, e164: string): Promise<void> {
    this.phoneVerifiedAt.set(this.freshKey(sessionToken, personId, await this.phoneHash(e164)), this.now());
  }

  private async phoneFreshInSession(sessionToken: string, personId: string, e164: string): Promise<boolean> {
    const at = this.phoneVerifiedAt.get(this.freshKey(sessionToken, personId, await this.phoneHash(e164)));
    return Boolean(at && at + FRESH_PHONE_MS > this.now());
  }

  private async maskedFor(kind: "phone" | "email", e164orEmail: string): Promise<string> {
    void kind;
    return e164orEmail.includes("@") ? maskEmail(e164orEmail) : maskPhone(e164orEmail);
  }

  // Text first: a handle with no person creates one, verified because it
  // came from the handle itself. No sign-up step, no password.
  async routeTextHandle(kind: "phone" | "email", raw: string): Promise<{ personId: string; created: boolean }> {
    const value = kind === "phone" ? normalizePhone(raw) : normalizeEmail(raw);
    if (!value) throw new Error(`Invalid ${kind}.`);
    const existing = await this.store.findPersonByHandle(kind, value);
    if (existing && !existing.mergedInto) {
      await this.engine.getThread(existing.id);
      return { personId: existing.id, created: false };
    }
    const { person } = await this.store.createPersonWithVerifiedHandle(kind, value);
    await this.engine.getThread(person.id);
    await this.engine.audit(person.id, "account.auto_created", {
      channel: "text",
      handleMasked: await this.maskedFor(kind, value),
    });
    return { personId: person.id, created: true };
  }

  // Phone sign-in, step 1. Same response and same send whether or not the
  // phone has an account. Unknown phones get a real code; verifying it
  // either signs in or links. Responds without waiting for delivery.
  async requestPhoneCode(rawPhone: string): Promise<{ ok: true }> {
    await this.codes.requestCode(rawPhone, (to, message) => this.channels.sendCode(to, message));
    return { ok: true };
  }

  // Phone sign-in, step 2. Returns the engine session key. A valid code on
  // an unknown phone creates the account, text-first: the code came from
  // the handle itself.
  async verifyPhoneCode(rawPhone: string, code: string): Promise<{ personId: string; sessionToken: string }> {
    const e164 = normalizePhone(rawPhone);
    if (!e164) throw new Error("Invalid code.");
    const ok = await this.codes.verifyCode(e164, code);
    if (!ok) throw new Error("Invalid code.");
    let owner = await this.store.findPersonByHandle("phone", e164);
    if (!owner || owner.mergedInto) {
      try {
        const created = await this.store.createPersonWithVerifiedHandle("phone", e164);
        owner = created.person;
        await this.engine.getThread(owner.id);
        await this.engine.audit(owner.id, "account.auto_created", {
          channel: "code",
          handleMasked: maskPhone(e164),
        });
      } catch (err) {
        if (!(err instanceof IdentityConflictError)) throw err;
        owner = await this.store.findPersonByHandle("phone", e164);
        if (!owner || owner.mergedInto) throw new Error("Invalid code.");
      }
    }
    const token = await this.engine.mintSession(owner.id);
    this.rememberSession(token, owner.id);
    await this.markPhoneFresh(token, owner.id, e164);
    await this.engine.audit(owner.id, "account.sign_in", {
      method: "phone",
      handleMasked: maskPhone(e164),
      channel: "web",
    });
    return { personId: owner.id, sessionToken: token };
  }

  // Verify a phone code while signed in, to link or to prove freshness.
  // Returns the owner of that phone. Records a link proof when it differs.
  async verifyPhoneForSession(
    sessionToken: string,
    rawPhone: string,
    code: string,
  ): Promise<{ ownerPersonId: string; samePerson: boolean }> {
    const personId = this.sessionPerson(sessionToken);
    const e164 = normalizePhone(rawPhone);
    if (!e164) throw new Error("Invalid code.");
    const ok = await this.codes.verifyCode(e164, code);
    if (!ok) throw new Error("Invalid code.");
    const owner = await this.store.findPersonByHandle("phone", e164);
    if (!owner || owner.mergedInto) throw new Error("Invalid code.");
    await this.markPhoneFresh(sessionToken, personId, e164);
    if (owner.id !== personId) this.addLinkProof(sessionToken, owner.id);
    return { ownerPersonId: owner.id, samePerson: owner.id === personId };
  }

  startEmailSignIn(
    state: string,
    provider: "authkit" | "GoogleOAuth" = "authkit",
    options?: WorkOSAuthOptions,
  ): string {
    return this.workos.authorizationUrl(state, provider, options);
  }

  // Email sign-in through WorkOS. AuthKit is the front door; the engine
  // session is the key. When signed in already, this links instead.
  async completeEmailSignIn(
    code: string,
    currentSessionToken?: string,
    options?: WorkOSAuthOptions,
  ): Promise<{ personId: string; sessionToken: string; linked: boolean }> {
    const user = await this.workos.authenticateWithCode(code, options);
    if (!user.id || !user.email || !user.emailVerified) throw new Error("Email was not verified.");
    if (await this.store.isWorkosUnlinked(user.id)) {
      throw new Error("That email is no longer on this account.");
    }
    const email = normalizeEmail(user.email);
    if (!email) throw new Error("Email was not verified.");
    const currentPersonId = currentSessionToken ? this.sessionPerson(currentSessionToken) : null;

    const byWorkos = await this.store.findPersonByWorkosUserId(user.id);
    if (byWorkos && !byWorkos.mergedInto) {
      if (currentPersonId && byWorkos.id !== currentPersonId) {
        this.addLinkProof(currentSessionToken as string, byWorkos.id);
        throw new IdentityConflictError("email");
      }
      const token = await this.engine.mintSession(byWorkos.id);
      this.rememberSession(token, byWorkos.id);
      await this.engine.audit(byWorkos.id, "account.sign_in", {
        method: "email",
        handleMasked: maskEmail(email),
        channel: currentPersonId ? "link" : "web",
      });
      return { personId: byWorkos.id, sessionToken: token, linked: Boolean(currentPersonId) };
    }

    const byEmail = await this.store.findPersonByHandle("email", email);
    if (byEmail && !byEmail.mergedInto) {
      if (currentPersonId && byEmail.id !== currentPersonId) {
        this.addLinkProof(currentSessionToken as string, byEmail.id);
        throw new IdentityConflictError("email");
      }
      const targetId = currentPersonId ?? byEmail.id;
      if (currentPersonId && currentPersonId !== byEmail.id) {
        throw new IdentityConflictError("email");
      }
      await this.store.addVerifiedIdentity(targetId, "workos", user.id);
      await this.store.setWorkosEmail(user.id, email);
      if (user.organizationId) await this.store.setWorkosOrganization(user.id, user.organizationId);
      const token = await this.engine.mintSession(targetId);
      this.rememberSession(token, targetId);
      await this.engine.audit(targetId, "account.sign_in", {
        method: "email",
        handleMasked: maskEmail(email),
        channel: currentPersonId ? "link" : "web",
      });
      return { personId: targetId, sessionToken: token, linked: Boolean(currentPersonId) };
    }

    if (currentPersonId) {
      await this.requireFreshPhoneForEmailAdd(currentPersonId, currentSessionToken as string);
      await this.store.addVerifiedIdentity(currentPersonId, "email", email);
      await this.store.addVerifiedIdentity(currentPersonId, "workos", user.id);
      await this.store.setWorkosEmail(user.id, email);
      if (user.organizationId) await this.store.setWorkosOrganization(user.id, user.organizationId);
      await this.engine.audit(currentPersonId, "account.identity_added", {
        kind: "email",
        handleMasked: maskEmail(email),
      });
      return { personId: currentPersonId, sessionToken: currentSessionToken as string, linked: true };
    }

    const { person } = await this.store.createPersonWithVerifiedHandle("email", email);
    await this.store.addVerifiedIdentity(person.id, "workos", user.id);
    await this.store.setWorkosEmail(user.id, email);
    if (user.organizationId) await this.store.setWorkosOrganization(user.id, user.organizationId);
    await this.engine.getThread(person.id);
    const token = await this.engine.mintSession(person.id);
    this.rememberSession(token, person.id);
    await this.engine.audit(person.id, "account.sign_in", {
      method: "email",
      handleMasked: maskEmail(email),
      channel: "web",
    });
    return { personId: person.id, sessionToken: token, linked: false };
  }

  // Phone-only accounts prove the phone with a fresh code in THIS session
  // before any email joins them. Carrier-recycled numbers make stale proof
  // unsafe.
  private async requireFreshPhoneForEmailAdd(personId: string, sessionToken: string): Promise<void> {
    const person = this.store.getPerson(personId);
    if (!person) throw new Error("Person not found.");
    const hasEmail = person.identities.some((i) => i.kind === "email");
    if (hasEmail) return;
    const phones = person.identities.filter((i) => i.kind === "phone");
    if (phones.length === 0) return;
    for (const identity of phones) {
      const raw = await this.store.reveal(identity);
      if (await this.phoneFreshInSession(sessionToken, personId, raw)) return;
    }
    throw new Error("Confirm your phone with a fresh code first.");
  }

  async addPhone(sessionToken: string, rawPhone: string, code: string): Promise<AccountView> {
    const personId = this.sessionPerson(sessionToken);
    const e164 = normalizePhone(rawPhone);
    if (!e164) throw new Error("Invalid phone.");
    const ok = await this.codes.verifyCode(e164, code);
    if (!ok) throw new Error("Invalid code.");
    const owner = await this.store.findPersonByHandle("phone", e164);
    if (owner && !owner.mergedInto && owner.id !== personId) {
      this.addLinkProof(sessionToken, owner.id);
      throw new IdentityConflictError("phone");
    }
    await this.store.addVerifiedIdentity(personId, "phone", e164);
    await this.markPhoneFresh(sessionToken, personId, e164);
    await this.engine.audit(personId, "account.identity_added", {
      kind: "phone",
      handleMasked: maskPhone(e164),
    });
    return this.getAccount(sessionToken);
  }

  async getAccount(sessionToken: string): Promise<AccountView> {
    const personId = this.sessionPerson(sessionToken);
    const person = this.store.getPerson(personId);
    if (!person || person.mergedInto) throw new Error("Person not found.");
    const identities: MaskedIdentity[] = [];
    for (const identity of person.identities) {
      const raw = await this.store.reveal(identity);
      const masked =
        identity.kind === "phone"
          ? maskPhone(raw)
          : identity.kind === "email"
            ? maskEmail(raw)
            : maskWorkosUserId(raw);
      identities.push({ id: identity.id, kind: identity.kind, masked, verified: identity.verified });
    }
    return { personId, identities };
  }

  // Remove one identity, never the last. Removing a phone needs a fresh
  // code to that phone. Phone numbers can be recycled by the carrier.
  // Removing an email unlinks its WorkOS identity in the same step, so
  // WorkOS sign-in through it fails afterwards.
  async removeIdentity(sessionToken: string, identityId: string, phoneCode?: string): Promise<AccountView> {
    const personId = this.sessionPerson(sessionToken);
    const person = this.store.getPerson(personId);
    if (!person || person.mergedInto) throw new Error("Person not found.");
    const target = person.identities.find((i) => i.id === identityId);
    if (!target) throw new Error("Identity not found.");
    if (target.kind === "phone") {
      const raw = await this.store.reveal(target);
      if (!(await this.phoneFreshInSession(sessionToken, personId, raw))) {
        if (!phoneCode) throw new Error("Confirm your phone with a fresh code first.");
        const ok = await this.codes.verifyCode(raw, phoneCode);
        if (!ok) throw new Error("Invalid code.");
        await this.markPhoneFresh(sessionToken, personId, raw);
      }
    }
    const { removed, unlinkedWorkosUserIds } = await this.store.removeIdentityAndLinkedWorkos(
      personId,
      identityId,
    );
    void removed;
    for (const userId of unlinkedWorkosUserIds) {
      try {
        await this.workos.deleteUser(userId);
      } catch {
        // The local tombstone already blocks re-sign-in; a failed remote
        // delete is recorded, not fatal. Never log the user ID.
        await this.engine.audit(personId, "account.workos_unlink_failed", { kind: target.kind });
      }
    }
    await this.engine.audit(personId, "account.identity_removed", { kind: target.kind });
    return this.getAccount(sessionToken);
  }

  // Merge preview: both identities must be verified in the same session.
  // The caller shows preview.confirmText exactly and asks for confirmation.
  async previewMerge(sessionToken: string, fromPersonId: string): Promise<{ previewId: string; preview: MergePreview }> {
    const intoPersonId = this.sessionPerson(sessionToken);
    if (fromPersonId === intoPersonId) throw new Error("Nothing to merge.");
    const from = this.store.getPerson(fromPersonId);
    const into = this.store.getPerson(intoPersonId);
    if (!from || from.mergedInto || !into || into.mergedInto) throw new Error("Person not found.");
    if (!this.hasLinkProof(sessionToken, fromPersonId)) {
      throw new Error("Verify the other identity in this session first.");
    }
    const counts = await this.engine.getDataCounts(fromPersonId);
    const confirmText =
      `Combine ${counts.conversationMessages} messages, ${counts.documents} documents, ` +
      `${counts.approvals} approvals and ${counts.consents} consents into one account. ` +
      `This cannot be undone.`;
    const preview: MergePreview = {
      fromPersonId,
      intoPersonId,
      moved: counts,
      confirmText,
    };
    const previewId = `merge_${this.previewSeq++}`;
    this.mergePreviews.set(previewId, {
      id: previewId,
      fromPersonId,
      intoPersonId,
      sessionToken,
      createdAt: this.now(),
      preview,
    });
    return { previewId, preview };
  }

  // Merge confirm, idempotent on the caller's key. The job records recovery
  // state across engine move, store merge, and finish, so a retry after a
  // failure resumes instead of duplicating. The moved data must still match
  // the confirmed preview, or the merge aborts. Merging an email into a
  // phone-only account needs a fresh phone code in this session, same as
  // linking. Without a key the merge runs once, unkeyed.
  async confirmMerge(
    sessionToken: string,
    previewId: string,
    confirmed: boolean,
    idempotencyKey?: string,
  ): Promise<AccountView> {
    const intoPersonId = this.sessionPerson(sessionToken);
    if (idempotencyKey) {
      const job = this.mergeJobs.get(idempotencyKey);
      if (job) {
        if (job.sessionToken !== sessionToken || job.intoPersonId !== intoPersonId) {
          throw new Error("Merge already started with a different session.");
        }
        if (job.state === "done") return this.getAccount(sessionToken);
        return this.runMergeJob(job, idempotencyKey);
      }
    }
    const row = this.mergePreviews.get(previewId);
    if (!row || row.sessionToken !== sessionToken || row.intoPersonId !== intoPersonId) {
      throw new Error("Merge preview expired. Start again.");
    }
    if (row.createdAt + MERGE_PREVIEW_TTL_MS <= this.now()) {
      this.mergePreviews.delete(previewId);
      throw new Error("Merge preview expired. Start again.");
    }
    if (!confirmed) {
      this.mergePreviews.delete(previewId);
      throw new Error("Merge was not confirmed.");
    }
    if (!this.hasLinkProof(sessionToken, row.fromPersonId)) {
      throw new Error("Verify the other identity in this session first.");
    }
    const from = this.store.getPerson(row.fromPersonId);
    const into = this.store.getPerson(row.intoPersonId);
    if (!from || from.mergedInto || !into || into.mergedInto) throw new Error("Person not found.");
    const mergeAddsEmail =
      from.identities.some((i) => i.kind === "email") &&
      into.identities.some((i) => i.kind === "phone") &&
      !into.identities.some((i) => i.kind === "email");
    if (mergeAddsEmail) {
      await this.requireFreshPhoneForEmailAdd(row.intoPersonId, sessionToken);
    }
    // The account must still hold exactly what the person confirmed.
    const current = await this.engine.getDataCounts(row.fromPersonId);
    const expected = row.preview.moved;
    if (
      current.conversationMessages !== expected.conversationMessages ||
      current.documents !== expected.documents ||
      current.approvals !== expected.approvals ||
      current.consents !== expected.consents
    ) {
      throw new Error("The account changed since the preview. Start again.");
    }
    const key = idempotencyKey ?? `mergejob_${this.jobSeq++}`;
    const job: MergeJob = {
      key,
      fromPersonId: row.fromPersonId,
      intoPersonId: row.intoPersonId,
      sessionToken,
      previewId,
      moved: { ...expected },
      state: "engine-move",
      updatedAt: this.now(),
    };
    this.mergeJobs.set(key, job);
    return this.runMergeJob(job, key);
  }

  private async runMergeJob(job: MergeJob, key: string): Promise<AccountView> {
    const touch = (state: MergeJob["state"]) => {
      job.state = state;
      job.updatedAt = this.now();
      this.mergeJobs.set(key, job);
    };
    try {
      if (job.state === "engine-move") {
        await this.engine.moveData(job.fromPersonId, job.intoPersonId, key);
        touch("store-merge");
      }
      if (job.state === "store-merge") {
        const from = this.store.getPerson(job.fromPersonId);
        if (!from) throw new Error("Person not found.");
        if (!from.mergedInto) {
          this.store.mergePeople(job.fromPersonId, job.intoPersonId);
        } else if (from.mergedInto !== job.intoPersonId) {
          throw new Error("Merge preview expired. Start again.");
        }
        touch("finish");
      }
      await this.engine.audit(job.intoPersonId, "account.merged", {
        fromPersonId: job.fromPersonId,
        moved: job.moved,
        at: this.iso(),
      });
      for (const [token, session] of [...this.sessions]) {
        if (session.personId === job.fromPersonId) this.sessions.delete(token);
      }
      await this.engine.revokeSessions(job.fromPersonId);
      this.mergePreviews.delete(job.previewId);
      touch("done");
      return this.getAccount(job.sessionToken);
    } catch (err) {
      job.updatedAt = this.now();
      this.mergeJobs.set(key, job);
      throw err;
    }
  }

  async signOutEverywhere(sessionToken: string): Promise<void> {
    const personId = this.sessionPerson(sessionToken);
    for (const [token, session] of [...this.sessions]) {
      if (session.personId === personId) this.sessions.delete(token);
    }
    await this.engine.revokeSessions(personId);
    await this.engine.audit(personId, "account.sign_out_everywhere", {});
  }

  // Delete is a recorded, retryable job across engine, channels, and store.
  // Each step is idempotent, so a retry after a partial failure finishes
  // without duplicating or losing work. Sessions clear only after the
  // outside deletes land, so a retry can still authenticate.
  async deleteAccount(sessionToken: string): Promise<void> {
    const personId = this.sessionPerson(sessionToken);
    const job: DeleteJob = {
      id: `del_${this.jobSeq++}_${Date.now().toString(36)}`,
      personId,
      engineDone: false,
      channelsDone: false,
      storeDone: false,
      attempts: 0,
      lastError: null,
      updatedAt: this.now(),
    };
    this.deleteJobs.set(job.id, job);
    return this.runDeleteJob(job);
  }

  // Retry a delete that did not finish. The unguessable job ID authorizes
  // the retry on its own; when a session is given it must belong to the
  // same person.
  async retryDeleteAccount(jobId: string, sessionToken?: string): Promise<void> {
    const job = this.deleteJobs.get(jobId);
    if (!job) throw new Error("Delete job not found.");
    if (sessionToken && this.sessionPerson(sessionToken) !== job.personId) {
      throw new Error("Delete job not found.");
    }
    return this.runDeleteJob(job);
  }

  deleteJobStatus(jobId: string): DeleteJob | null {
    const job = this.deleteJobs.get(jobId);
    return job ? { ...job } : null;
  }

  private async runDeleteJob(job: DeleteJob): Promise<void> {
    job.attempts += 1;
    job.updatedAt = this.now();
    try {
      if (!job.engineDone) {
        await this.engine.deleteData(job.personId);
        job.engineDone = true;
        job.updatedAt = this.now();
      }
      if (!job.channelsDone) {
        await this.channels.deleteConversationsForPerson(job.personId);
        job.channelsDone = true;
        job.updatedAt = this.now();
      }
      for (const [token, session] of [...this.sessions]) {
        if (session.personId === job.personId) this.sessions.delete(token);
      }
      if (!job.storeDone) {
        this.store.deletePerson(job.personId);
        job.storeDone = true;
        job.updatedAt = this.now();
      }
      job.lastError = null;
      this.deleteJobs.set(job.id, job);
    } catch (err) {
      job.lastError = (err as Error).message;
      job.updatedAt = this.now();
      this.deleteJobs.set(job.id, job);
      throw new DeleteIncompleteError(job.id);
    }
  }

  async getThread(sessionToken: string): Promise<
    { id: string; role: "user" | "assistant"; content: string; channel: "text" | "web" | "app"; createdAt: string }[]
  > {
    const personId = this.sessionPerson(sessionToken);
    return this.engine.getThread(personId);
  }

  async appendThread(
    sessionToken: string,
    input: { role: "user" | "assistant"; content: string; channel: "text" | "web" | "app" },
  ): Promise<{ id: string; replyChannel: "text" | "web" | "app" }> {
    const personId = this.sessionPerson(sessionToken);
    const row = await this.engine.appendThread(personId, input);
    // A reply goes back on the channel the message came from.
    const replyChannel = input.channel;
    return { id: row.id, replyChannel };
  }

  // Test hook: how long a phone code stays valid.
  codeTtlMs(): number {
    return CODE_TTL_MS;
  }
}
