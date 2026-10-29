// Identity and person storage.
// Lookup is by keyed hash only. The encrypted value is stored alongside.
// A phone or email belongs to at most one person. Never log hashes or values.
// Identity claims are atomic: the check and the insert run under one
// per-handle lock, so parallel claims let exactly one win. WorkOS user IDs
// and emails rest encrypted; only internal person and organization IDs stay
// in the clear. Deletion removes link rows for real, it never just nulls
// the person ID.

import { decryptValue, encryptValue, keyedHash, lookupDomain, randomId } from "./crypto";
import { withKeyedLock } from "./locks";
import { normalizeEmail, normalizePhone } from "./normalize";
import type { Identity, IdentityKind, Person, WorkOSLink } from "./types";

export interface StoreConfig {
  pepper: string;
  kekB64: string;
  now?: () => number;
}

export class IdentityConflictError extends Error {
  constructor(kind: IdentityKind) {
    super(`That ${kind} already belongs to another person.`);
    this.name = "IdentityConflictError";
  }
}

// Sealed WorkOS link row. The user ID and email rest encrypted; the map
// key is the keyed hash of the user ID, never the ID itself.
interface SealedWorkosLink {
  encryptedUserId: string;
  encryptedEmail: string | null;
  personId: string | null;
  organizationId: string | null;
}

export class PersonStore {
  private people = new Map<string, Person>();
  private byLookup = new Map<string, string>();
  private workosLinks = new Map<string, SealedWorkosLink>();
  private workosByEmailHash = new Map<string, Set<string>>();
  private unlinkedWorkos = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();
  private pepper: string;
  private kekB64: string;
  private now: () => number;

  constructor(config: StoreConfig) {
    this.pepper = config.pepper;
    this.kekB64 = config.kekB64;
    this.now = config.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  async hashFor(kind: "phone" | "email" | "workos", value: string): Promise<string> {
    return keyedHash(value, this.pepper, lookupDomain(kind));
  }

  private async workosKey(workosUserId: string): Promise<string> {
    return this.hashFor("workos", workosUserId);
  }

  async reveal(identity: Identity): Promise<string> {
    return decryptValue(identity.encryptedValue, this.kekB64);
  }

  getPerson(personId: string): Person | null {
    return this.people.get(personId) ?? null;
  }

  async findPersonByHandle(kind: "phone" | "email", raw: string): Promise<Person | null> {
    const value = kind === "phone" ? normalizePhone(raw) : normalizeEmail(raw);
    if (!value) return null;
    const hash = await this.hashFor(kind, value);
    const personId = this.byLookup.get(`${kind}:${hash}`);
    if (!personId) return null;
    return this.people.get(personId) ?? null;
  }

  async findPersonByWorkosUserId(workosUserId: string): Promise<Person | null> {
    const hash = await this.hashFor("workos", workosUserId);
    const personId = this.byLookup.get(`workos:${hash}`);
    if (!personId) return null;
    return this.people.get(personId) ?? null;
  }

  // True when this WorkOS identity was unlinked by removing its email.
  // Sign-in through it fails afterwards instead of reopening the account.
  async isWorkosUnlinked(workosUserId: string): Promise<boolean> {
    return this.unlinkedWorkos.has(await this.workosKey(workosUserId));
  }

  private async unsealLink(key: string, row: SealedWorkosLink): Promise<WorkOSLink> {
    return {
      workosUserId: await decryptValue(row.encryptedUserId, this.kekB64),
      personId: row.personId,
      organizationId: row.organizationId,
      email: row.encryptedEmail ? await decryptValue(row.encryptedEmail, this.kekB64) : null,
    };
  }

  async getWorkosLink(workosUserId: string): Promise<WorkOSLink | null> {
    const row = this.workosLinks.get(await this.workosKey(workosUserId));
    if (!row) return null;
    return this.unsealLink(await this.workosKey(workosUserId), row);
  }

  // Orgs seam: attach an organization to a WorkOS user without touching the person link.
  async setWorkosOrganization(workosUserId: string, organizationId: string | null): Promise<WorkOSLink | null> {
    const key = await this.workosKey(workosUserId);
    const row = this.workosLinks.get(key);
    if (!row) return null;
    row.organizationId = organizationId;
    return this.unsealLink(key, row);
  }

  async createPersonWithVerifiedHandle(
    kind: "phone" | "email",
    raw: string,
  ): Promise<{ person: Person; identity: Identity }> {
    const value = kind === "phone" ? normalizePhone(raw) : normalizeEmail(raw);
    if (!value) throw new Error(`Invalid ${kind}.`);
    const hash = await this.hashFor(kind, value);
    return withKeyedLock(this.locks, `claim:${kind}:${hash}`, async () => {
      const existing = this.byLookup.get(`${kind}:${hash}`);
      if (existing) throw new IdentityConflictError(kind);
      const now = this.iso();
      const personId = randomId("person");
      const identity: Identity = {
        id: randomId("idn"),
        kind,
        lookupHash: hash,
        encryptedValue: await encryptValue(value, this.kekB64),
        verified: true,
        verifiedAt: now,
        createdAt: now,
      };
      const person: Person = { id: personId, identities: [identity], createdAt: now, mergedInto: null };
      this.people.set(personId, person);
      this.byLookup.set(`${kind}:${hash}`, personId);
      return { person, identity };
    });
  }

  async addVerifiedIdentity(
    personId: string,
    kind: "phone" | "email" | "workos",
    raw: string,
  ): Promise<Identity> {
    const person = this.people.get(personId);
    if (!person || person.mergedInto) throw new Error("Person not found.");
    let value = raw;
    if (kind === "phone") {
      const v = normalizePhone(raw);
      if (!v) throw new Error("Invalid phone.");
      value = v;
    } else if (kind === "email") {
      const v = normalizeEmail(raw);
      if (!v) throw new Error("Invalid email.");
      value = v;
    } else if (!value) {
      throw new Error("Invalid WorkOS user.");
    }
    if (kind === "workos" && this.unlinkedWorkos.has(await this.workosKey(value))) {
      throw new Error("That email is no longer on this account.");
    }
    const hash = await this.hashFor(kind, value);
    return withKeyedLock(this.locks, `claim:${kind}:${hash}`, async () => {
      const owner = this.byLookup.get(`${kind}:${hash}`);
      if (owner && owner !== personId) throw new IdentityConflictError(kind);
      if (owner === personId) {
        const found = person.identities.find((i) => i.kind === kind && i.lookupHash === hash);
        if (found) {
          found.verified = true;
          found.verifiedAt = this.iso();
          return found;
        }
      }
      const now = this.iso();
      const identity: Identity = {
        id: randomId("idn"),
        kind,
        lookupHash: hash,
        encryptedValue: await encryptValue(value, this.kekB64),
        verified: true,
        verifiedAt: now,
        createdAt: now,
      };
      person.identities.push(identity);
      this.byLookup.set(`${kind}:${hash}`, personId);
      if (kind === "workos") {
        const key = await this.workosKey(value);
        const row = this.workosLinks.get(key) ?? {
          encryptedUserId: await encryptValue(value, this.kekB64),
          encryptedEmail: null,
          personId: null,
          organizationId: null,
        };
        row.personId = personId;
        this.workosLinks.set(key, row);
      }
      return identity;
    });
  }

  async setWorkosEmail(workosUserId: string, email: string | null): Promise<void> {
    const key = await this.workosKey(workosUserId);
    const row = this.workosLinks.get(key);
    if (!row) return;
    if (row.encryptedEmail) {
      const oldEmail = await decryptValue(row.encryptedEmail, this.kekB64);
      const oldHash = await this.hashFor("email", oldEmail);
      const set = this.workosByEmailHash.get(oldHash);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.workosByEmailHash.delete(oldHash);
      }
    }
    row.encryptedEmail = email ? await encryptValue(email, this.kekB64) : null;
    if (email) {
      const emailHash = await this.hashFor("email", email);
      let set = this.workosByEmailHash.get(emailHash);
      if (!set) {
        set = new Set();
        this.workosByEmailHash.set(emailHash, set);
      }
      set.add(key);
    }
  }

  // WorkOS user IDs whose link email matches, decrypted only to return.
  async findWorkosUserIdsForEmail(email: string): Promise<string[]> {
    const emailHash = await this.hashFor("email", email);
    const keys = this.workosByEmailHash.get(emailHash);
    if (!keys) return [];
    const out: string[] = [];
    for (const key of keys) {
      const row = this.workosLinks.get(key);
      if (row) out.push(await decryptValue(row.encryptedUserId, this.kekB64));
    }
    return out;
  }

  // Remove one identity. Removing an email also removes the WorkOS identity
  // rows linked to that email and tombstones their user IDs, atomically in
  // the same step, so WorkOS sign-in through them fails afterwards.
  // Returns the unlinked WorkOS user IDs for the WorkOS-side delete call.
  async removeIdentityAndLinkedWorkos(
    personId: string,
    identityId: string,
  ): Promise<{ removed: Identity[]; unlinkedWorkosUserIds: string[] }> {
    const person = this.people.get(personId);
    if (!person || person.mergedInto) throw new Error("Person not found.");
    const idx = person.identities.findIndex((i) => i.id === identityId);
    if (idx < 0) throw new Error("Identity not found.");
    const target = person.identities[idx];
    const removalIds = new Set<string>([target.id]);
    const unlinkedWorkosUserIds: string[] = [];
    if (target.kind === "email") {
      const email = await this.reveal(target);
      const userIds = await this.findWorkosUserIdsForEmail(email);
      for (const identity of person.identities) {
        if (identity.kind !== "workos") continue;
        const userId = await this.reveal(identity);
        if (userIds.includes(userId)) {
          removalIds.add(identity.id);
          unlinkedWorkosUserIds.push(userId);
        }
      }
    } else if (target.kind === "workos") {
      unlinkedWorkosUserIds.push(await this.reveal(target));
    }
    if (person.identities.length - removalIds.size < 1) {
      throw new Error("The last identity cannot be removed.");
    }
    const removed: Identity[] = [];
    person.identities = person.identities.filter((i) => {
      if (!removalIds.has(i.id)) return true;
      removed.push(i);
      return false;
    });
    for (const identity of removed) {
      this.byLookup.delete(`${identity.kind}:${identity.lookupHash}`);
    }
    for (const userId of unlinkedWorkosUserIds) {
      const key = await this.workosKey(userId);
      const row = this.workosLinks.get(key);
      if (row) {
        if (row.encryptedEmail) {
          const email = await decryptValue(row.encryptedEmail, this.kekB64);
          const emailHash = await this.hashFor("email", email);
          const set = this.workosByEmailHash.get(emailHash);
          if (set) {
            set.delete(key);
            if (set.size === 0) this.workosByEmailHash.delete(emailHash);
          }
        }
        this.workosLinks.delete(key);
      }
      this.unlinkedWorkos.add(key);
    }
    return { removed, unlinkedWorkosUserIds };
  }

  // Single-row removal for phones. Emails go through
  // removeIdentityAndLinkedWorkos so the WorkOS identity leaves with them.
  async removeIdentity(personId: string, identityId: string): Promise<Identity> {
    const { removed } = await this.removeIdentityAndLinkedWorkos(personId, identityId);
    const first = removed.find((i) => i.id === identityId);
    if (!first) throw new Error("Identity not found.");
    return first;
  }

  // Merge moves every identity row into the surviving person.
  // Callers move conversation, documents, approvals and consents first,
  // then call this to re-point the identities. Never merges silently:
  // the service layer requires a confirmed MergePreview.
  mergePeople(fromPersonId: string, intoPersonId: string): Person {
    const from = this.people.get(fromPersonId);
    const into = this.people.get(intoPersonId);
    if (!from || !into || from.mergedInto || into.mergedInto) throw new Error("Person not found.");
    if (fromPersonId === intoPersonId) throw new Error("Cannot merge a person into themselves.");
    for (const identity of from.identities) {
      const clash = into.identities.find((i) => i.kind === identity.kind && i.lookupHash === identity.lookupHash);
      if (clash) {
        clash.verified = clash.verified || identity.verified;
        continue;
      }
      into.identities.push(identity);
      this.byLookup.set(`${identity.kind}:${identity.lookupHash}`, intoPersonId);
    }
    from.identities = [];
    from.mergedInto = intoPersonId;
    for (const row of this.workosLinks.values()) {
      if (row.personId === fromPersonId) row.personId = intoPersonId;
    }
    return into;
  }

  // Delete removes the person, every lookup entry, and every WorkOS link
  // row for real. Nothing keeps pointing at the deleted person.
  deletePerson(personId: string): void {
    const person = this.people.get(personId);
    if (!person) return;
    for (const identity of person.identities) {
      this.byLookup.delete(`${identity.kind}:${identity.lookupHash}`);
    }
    for (const [key, row] of [...this.workosLinks]) {
      if (row.personId === personId) {
        void key;
        this.workosLinks.delete(key);
      }
    }
    for (const [emailHash, set] of [...this.workosByEmailHash]) {
      for (const key of [...set]) {
        if (!this.workosLinks.has(key)) set.delete(key);
      }
      if (set.size === 0) this.workosByEmailHash.delete(emailHash);
    }
    this.people.delete(personId);
  }

  listPeople(): Person[] {
    return [...this.people.values()];
  }
}
