// Sharing the person's renewal with one organization. Each step is a share
// action Engine freezes and holds for their YES: the grant, a document
// answering what the organization asked for, and stopping. Only our own
// sandbox office can be chosen (hard rule 2).
//
// A case ID is the same on every attempt of a turn, so a replay finds the
// draft it made. Stopping is final for that case, so sharing again later
// opens a new one, and the office sees nothing of the old case in it.
import { createHash } from "node:crypto";

import { SANDBOX_ORG_AGENT_ID, recipientName } from "@mano/protocol";

import type { EngineDeadline, EngineShare, PersonEngine, Profile } from "./engine.js";
import { holdForYes, type Draft, type HoldResult } from "./propose.js";

export const SHARE_ORG = SANDBOX_ORG_AGENT_ID;
export const SHARE_PURPOSE = "your food benefits renewal";
export const SHARE_FORM = "share";

export interface ShareDetail {
  label: string;
  value: string;
}

// One case per person for this renewal, and one more each time they shared
// it again after stopping.
export function shareCaseId(personId: string, round: number): string {
  const id = createHash("sha256").update(`${personId}\n${SHARE_PURPOSE}`).digest("hex").slice(0, 32);
  return `renewal-${id}${round > 0 ? `-${round}` : ""}`;
}

// The values the grant shares, by the words the question and the caseworker
// read: only what the person told Mano about this renewal.
export function renewalDetails(profile: Profile | null, deadlines: EngineDeadline[] | null): ShareDetail[] {
  const program = profile?.programs.find((p) => p.caseNumber?.value) ?? profile?.programs[0];
  const rows: [string, string | undefined][] = [
    ["Name", profile?.person.fullName?.value],
    ["Program", program?.program?.value],
    ["Case number", program?.caseNumber?.value],
    ["Renewal due", deadlines?.find((d) => d.status === "open" && d.kind === "renewal")?.dueDate],
  ];
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

export function grantDraft(caseId: string, details: ShareDetail[]): Draft {
  return {
    type: "share",
    recipient: SHARE_ORG,
    purpose: SHARE_PURPOSE,
    payload: { consent: "grant", caseId, scope: details.map((d) => d.label), details },
  };
}

export function revokeDraft(share: Pick<EngineShare, "recipient" | "caseId" | "purpose">): Draft {
  return {
    type: "share",
    recipient: share.recipient,
    purpose: `stop sharing ${share.purpose}`,
    payload: { consent: "revoke", caseId: share.caseId, sharedFor: share.purpose },
  };
}

function oldestRequest(shares: EngineShare[]) {
  return shares
    .flatMap((share) => share.openRequests.map((request) => ({ share, request })))
    .sort((a, b) => a.request.requestedAt.localeCompare(b.request.requestedAt))[0];
}

// A photo the person texted while an organization waits on a document is
// their answer to it: Mano asks, naming that photo, and it goes only after
// their YES. A message with more than one photo is never guessed between: it
// holds nothing and asks for the one they mean, so a YES can only ever send a
// photo the question identified. Null when nothing waits, and the photo is
// read as usual. A stored photo that an Engine outage keeps Mano from
// checking also reads as usual, and sends nothing.
export async function answerRequestWithPhoto(
  engine: PersonEngine,
  turn: { turnId: string; turnAtMs: number },
  documentIds: string[],
  photoCount: number,
): Promise<HoldResult | { pickOne: string } | null> {
  let shares: EngineShare[];
  try {
    shares = (await engine.listShares()).active;
  } catch {
    console.warn(JSON.stringify({ type: "mano_shares_unread" }));
    return null;
  }
  const open = oldestRequest(shares);
  if (!open) return null;
  const office = recipientName(open.share.recipient);
  if (photoCount !== 1 || documentIds.length !== 1) {
    return {
      pickOne: `You sent ${Math.max(photoCount, documentIds.length)} photos, and ${office} asked for your ${open.request.label}. Nothing was sent. Send just the one photo you want them to have, by itself, and I will check with you first.`,
    };
  }
  const documentId = documentIds[0]!;
  const photo = (await engine.listDocuments()).find((d) => d.id === documentId);
  if (!photo) return { held: false, status: "blocked", reason: "That photo is not on file." };
  return holdForYes(engine, { session: { turn: { id: turn.turnId } } }, turn, {
    type: "share",
    recipient: open.share.recipient,
    purpose: `send your ${open.request.label} to ${office}`,
    payload: {
      consent: "provide",
      caseId: open.share.caseId,
      requestId: open.request.id,
      documentKind: open.request.documentKind,
      label: open.request.label,
      sharedFor: open.share.purpose,
      attachment: photo.label,
    },
    documentId,
  });
}
