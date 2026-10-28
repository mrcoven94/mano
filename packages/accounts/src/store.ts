// Identity and person storage.
// Lookup is by keyed hash only. The encrypted value is stored alongside.
// A phone or email belongs to at most one person. Never log hashes or values.

import { decryptValue, encryptValue, keyedHash, lookupDomain, randomId } from "./crypto";
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

export class PersonStore {
  private people = new Map<string, Person>();
  private byLookup = new Map<string, string>();
  private workosLinks = new Map<string, WorkOSLink>();
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

  getWorkosLink(workosUserId: string): WorkOSLink | null {
    return this.workosLinks.get(workosUserId) ?? null;
  }

  // Orgs seam: attach an organization to a WorkOS user without touching the person link.
  setWorkosOrganization(workosUserId: string, organizationId: string | null): WorkOSLink | null {
    const link = this.workosLinks.get(workosUserId);
    if (!link) return null;
    link.organizationId = organizationId;
    return link;
  }

  async createPersonWithVerifiedHandle(
    kind: "phone" | "email",
    raw: string,
  ): Promise<{ person: Person; identity: Identity }> {
    const value = kind === "phone" ? normalizePhone(raw) : normalizeEmail(raw);
    if (!value) throw new Error(`Invalid ${kind}.`);
    const hash = await this.hashFor(kind, value);
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
    const hash = await this.hashFor(kind, value);
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
      const link = this.workosLinks.get(value) ?? {
        workosUserId: value,
        personId: null,
        organizationId: null,
        email: null,
      };
      link.personId = personId;
      this.workosLinks.set(value, link);
    }
    return identity;
  }

  setWorkosEmail(workosUserId: string, email: string | null): void {
    const link = this.workosLinks.get(workosUserId);
    if (link) link.email = email;
  }

  removeIdentity(personId: string, identityId: string): Identity {
    const person = this.people.get(personId);
    if (!person || person.mergedInto) throw new Error("Person not found.");
    if (person.identities.length <= 1) throw new Error("The last identity cannot be removed.");
    const idx = person.identities.findIndex((i) => i.id === identityId);
    if (idx < 0) throw new Error("Identity not found.");
    const [removed] = person.identities.splice(idx, 1);
    this.byLookup.delete(`${removed.kind}:${removed.lookupHash}`);
    if (removed.kind === "workos") {
      void this.reveal(removed).then((value) => {
        const link = this.workosLinks.get(value);
        if (link && link.personId === personId) link.personId = null;
      });
    }
    return removed;
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
    for (const link of this.workosLinks.values()) {
      if (link.personId === fromPersonId) link.personId = intoPersonId;
    }
    return into;
  }

  deletePerson(personId: string): void {
    const person = this.people.get(personId);
    if (!person) return;
    for (const identity of person.identities) {
      this.byLookup.delete(`${identity.kind}:${identity.lookupHash}`);
    }
    for (const link of this.workosLinks.values()) {
      if (link.personId === personId) link.personId = null;
    }
    this.people.delete(personId);
  }

  listPeople(): Person[] {
    return [...this.people.values()];
  }
}
