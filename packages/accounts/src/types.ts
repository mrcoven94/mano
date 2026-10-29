// Core shapes for one person, one Mano account.
// A person has one or more verified identities: phone (E.164), email,
// and the WorkOS user ID. Phone or email belongs to at most one person.

export type IdentityKind = "phone" | "email" | "workos";

export interface Identity {
  id: string;
  kind: IdentityKind;
  // Keyed hash for lookup. The raw value is never used as a key or logged.
  lookupHash: string;
  // Encrypted value. Decrypt only to send a code or show a masked view.
  encryptedValue: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export interface Person {
  id: string;
  identities: Identity[];
  createdAt: string;
  // Set when this person was merged into another. The old ID stops working.
  mergedInto: string | null;
}

export interface MaskedIdentity {
  id: string;
  kind: IdentityKind;
  masked: string;
  verified: boolean;
}

export interface AccountView {
  personId: string;
  identities: MaskedIdentity[];
}

export interface MergePreview {
  fromPersonId: string;
  intoPersonId: string;
  moved: {
    conversationMessages: number;
    documents: number;
    approvals: number;
    consents: number;
  };
  // Exact text the confirmation screen shows. The person confirms this text.
  confirmText: string;
}

export interface ActivityEvent {
  at: string;
  personId: string;
  event: string;
  // Masked handle only, never the full number or email. Never the code.
  handleMasked: string | null;
  channel: string | null;
}

export type WorkOSLink = {
  workosUserId: string;
  // A WorkOS user can belong to a person, an organization, or both.
  // Organizations are the Orgs session seam; accounts only reads personId.
  personId: string | null;
  organizationId: string | null;
  email: string | null;
};
