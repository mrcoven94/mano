// Approvals the agent proposes, as Engine holds them. Engine owns the
// frozen request, its hash, expiry and execution, and keeps the one
// pointer to the approval that may be answered by text. That pointer is
// set only after Channels reports the question reached the person word
// for word, so an approval with no pointer has not been shown, and a YES
// to it approves nothing. Engine reads the pointer only under the current
// Channels deletion generation, so nothing from before a deletion is ever
// answered.
//
// The question is rendered from the request Engine froze, never from the
// model's words, so the person reads the exact content their yes sends.
import { createHash } from "node:crypto";

import type { ReplyLanguage } from "@mano/mail";
import { guardReply } from "@mano/persona";
import { recipientName } from "@mano/protocol";

import type { EngineApproval } from "./engine.js";
import { FORMS } from "./forms.js";
import { QUESTION_WORDS } from "./words.js";

// The exact version uses each form's own labels, in the form's order.
const LABELS: Record<string, string> = Object.fromEntries(
  Object.values(FORMS).flatMap((form) => form.fields.map((field) => [field.name, field.label])),
);

// The payload key a draft freezes the attached document's label under,
// such as "the letter you sent on November 2". The portal files only the
// form's own fields, so it never receives it.
export const ATTACHMENT = "attachment";

const LINK_START = /https?:\/\/|www\./i;
const WHITESPACE_RUN = /\s+/g;

// The payload key a draft freezes its form's declaration under, word for
// word. The question shows it, so the person's YES is what makes it, and
// Engine files it as theirs only after that YES.
export const DECLARATION = "declaration";

// The key names the conversation generation and the turn that proposed
// it, so the agent only ever reads proposals of the current conversation.
function prefix(generation: number): string {
  return `agent:g${generation}:`;
}

// A draft's key is its turn plus its place among that turn's drafts, so a
// replay of the turn proposes under the same key and Engine hands back the
// approval it already holds instead of a new one.
export function proposalKey(generation: number, turnId: string, place: number): string {
  return `${prefix(generation)}${turnId}:d${place}`;
}

// Closing drafts that are no longer the latest proposal is cleanup only:
// Engine already refuses to approve them, closed or not. Engine decides
// which to close when the call runs; the agent never passes IDs from an
// earlier read. A failure is logged (no content) and retried at the next
// turn.
export async function closeReplaced(engine: { supersede(): Promise<number> }): Promise<void> {
  try {
    await engine.supersede();
  } catch {
    console.warn(JSON.stringify({ type: "mano_close_failed" }));
  }
}

// The agent's proposals in this conversation, newest first.
export function proposalsOf(approvals: EngineApproval[], generation: number): EngineApproval[] {
  return approvals
    .filter((a) => a.idempotencyKey.startsWith(prefix(generation)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Drafts this process could not close after the person corrected them in
// the same turn: one draft by its ID, or every draft of a turn when Engine
// could not even list them. Engine still holds them pending, so the turn's
// reply must not show their question; never shown, they have no pointer,
// and a YES approves none of them. Kept for the life of the process,
// oldest dropped first, since the reply goes out within the same turn.
const HELD_BACK = new Set<string>();
const HELD_BACK_MAX = 1000;

export function holdBack(target: { approvalId: string } | { turnId: string }): void {
  HELD_BACK.add("approvalId" in target ? `a:${target.approvalId}` : `t:${target.turnId}`);
  if (HELD_BACK.size > HELD_BACK_MAX) HELD_BACK.delete(HELD_BACK.values().next().value!);
}

export function heldBack(turnId: string, approvalId: string): boolean {
  return HELD_BACK.has(`a:${approvalId}`) || HELD_BACK.has(`t:${turnId}`);
}

const KEY_GENERATION_PREFIX = /^agent:g\d+:/;
const KEY_DRAFT_SUFFIX = /:d\d+$/;

// The turn a drafted approval came from, read from its key (see proposalKey).
function turnOf(idempotencyKey: string): string {
  return idempotencyKey.replace(KEY_GENERATION_PREFIX, "").replace(KEY_DRAFT_SUFFIX, "");
}

// The one check before an approval question is shown or counted as shown:
// the question to show, or null for a draft held back after a correction
// or one the text line would not carry word for word.
export function presentable(approval: Pick<EngineApproval, "id" | "idempotencyKey" | "purpose" | "recipient" | "requestJson">, language: ReplyLanguage = "en"): string | null {
  if (heldBack(turnOf(approval.idempotencyKey), approval.id)) return null;
  const question = renderQuestion(approval, language);
  return presentsExactly(question) ? question : null;
}

// The drafts one turn proposed that still wait, newest first.
export function waitingFrom(approvals: EngineApproval[], generation: number, turnId: string): EngineApproval[] {
  return proposalsOf(approvals, generation).filter((a) => a.status === "pending" && a.idempotencyKey.startsWith(`${prefix(generation)}${turnId}:`));
}

// The approval this turn proposed and Engine still holds.
export function proposedIn(approvals: EngineApproval[], generation: number, turnId: string): EngineApproval | null {
  return waitingFrom(approvals, generation, turnId)[0] ?? null;
}

// Proposals of this conversation still waiting that are not the answerable one.
export function waitingProposals(approvals: EngineApproval[], generation: number, exceptId: string | null = null): EngineApproval[] {
  return proposalsOf(approvals, generation).filter((a) => a.status === "pending" && a.id !== exceptId);
}

// A share action's words, one per effect, from what Engine froze. Null for
// any other action.
function frozenShare(approval: Pick<EngineApproval, "requestJson">): Record<string, unknown> | null {
  try {
    const payload = (JSON.parse(approval.requestJson) as { payload?: Record<string, unknown> }).payload;
    return typeof payload?.consent === "string" ? payload : null;
  } catch {
    return null;
  }
}

function shareQuestion(approval: Pick<EngineApproval, "purpose" | "recipient" | "requestJson">, share: Record<string, unknown>): string | null {
  const office = recipientName(approval.recipient);
  switch (share.consent) {
    case "grant": {
      const details = ((share.details ?? []) as { label: string; value: string }[]).map((d) => `${d.label}: ${d.value}`);
      return `Ready to share ${approval.purpose} with ${office}: ${details.join("; ")}. They can also ask you for documents, and nothing else goes to them without your yes. Reply YES to share exactly this, or NO to stop.`;
    }
    case "revoke":
      return `Ready to stop sharing ${String(share.sharedFor)} with ${office}. They lose access right away and cannot ask you for more. Stopping cannot recall what they already received. Reply YES to stop sharing, or NO to keep sharing.`;
    case "provide":
      return `Ready to send ${String(share.attachment)} to ${office}, as your ${String(share.label)} for ${String(share.sharedFor)}. Reply YES to send exactly this, or NO to stop.`;
    default:
      return null;
  }
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// What Mano says once a share action went through. Null for any other action.
export function shareDone(approval: Pick<EngineApproval, "recipient" | "purpose" | "requestJson">): string | null {
  const share = frozenShare(approval);
  const office = recipientName(approval.recipient);
  switch (share?.consent) {
    case "grant":
      return `Done. ${sentence(office)} can now see what you shared for ${approval.purpose}. Tell me any time if you want to stop sharing.`;
    case "revoke":
      return `Done. ${sentence(office)} can no longer see ${String(share.sharedFor)} or ask you for more. Stopping cannot recall what they already received.`;
    case "provide":
      return `Done. I sent your ${String(share.label)} to ${office}.`;
    default:
      return null;
  }
}

export function isShare(approval: Pick<EngineApproval, "requestJson">): boolean {
  return frozenShare(approval) !== null;
}

export function isShareGrant(approval: Pick<EngineApproval, "requestJson">): boolean {
  return frozenShare(approval)?.consent === "grant";
}

// The known declaration, whichever form it closes. Only this exact wording
// gets a meaning in the person's language: any other stays English alone.
const PERJURY = /^I declare under penalty of perjury that the information in this .+ is true, correct and complete to the best of my knowledge\.$/;

// In the person's language only the frame changes. The purpose, labels,
// values, office and declaration are the frozen English the yes approves.
// A share question is English for now, in every language.
export function renderQuestion(approval: Pick<EngineApproval, "purpose" | "recipient" | "requestJson">, language: ReplyLanguage = "en"): string {
  const words = QUESTION_WORDS[language];
  const share = frozenShare(approval);
  const shared = share && shareQuestion(approval, share);
  if (shared) return shared;
  let payload: Record<string, unknown> = {};
  let attached: string | null = null;
  let declaration: string | null = null;
  try {
    const frozen = JSON.parse(approval.requestJson) as { payload?: Record<string, unknown>; documentId?: unknown };
    payload = frozen.payload ?? {};
    if (typeof payload[DECLARATION] === "string") declaration = payload[DECLARATION];
    const label = payload[ATTACHMENT];
    if (typeof frozen.documentId === "string" && frozen.documentId !== "") {
      attached = typeof label === "string" && label !== "" ? label : "your document";
    }
  } catch {
    // Unreadable frozen request: the question shows purpose and recipient only.
  }
  const order = (k: string) => {
    const i = Object.keys(LABELS).indexOf(k);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const lines = Object.entries(payload)
    .filter(([k, v]) => k !== ATTACHMENT && k !== DECLARATION && (typeof v === "string" || typeof v === "number"))
    .sort(([a], [b]) => order(a) - order(b))
    .map(([k, v]) => `${LABELS[k] ?? k}: ${v}`);
  // One paragraph: the text line flattens line breaks, so fields are
  // separated in the sentence itself.
  return [
    words.ready(approval.purpose, recipientName(approval.recipient)),
    lines.length > 0 ? `${lines.join("; ")}.` : "",
    attached ? words.attached(attached) : "",
    declaration ? `${words.declares(PERJURY.test(declaration) ? words.perjuryMeaning : null)} ${declaration}` : "",
    declaration ? words.answerWithDeclaration : words.answer,
  ]
    .filter(Boolean)
    .join(" ");
}

// The line after the question that links to the replay of the fill
// behind it. It is never part of the question: the question stays the
// exact text the person answers, and the line can be dropped (a link
// check that blocks it) without touching the question.
export function replayLine(url: string, language: ReplyLanguage = "en"): string {
  return QUESTION_WORDS[language].replay(url);
}

// True when the text line would carry the question word for word: the
// shared voice guard (which drops any sentence naming a model or
// provider, and rewrites dashes and markdown) leaves it unchanged, and it
// holds no link for the link check to strip. Anything else cannot be put
// to a YES. Channels runs the same check before sending.
export function presentsExactly(question: string): boolean {
  return guardReply(question).text === question && !LINK_START.test(question);
}

// What Channels reports after it sent a question: SHA-256 (hex) of the
// question with runs of whitespace collapsed to one space, since the
// text line may split it into bubbles at spaces. Channels computes the
// same hash over what it sent.
export function presentationHash(text: string): string {
  return createHash("sha256").update(text.replace(WHITESPACE_RUN, " ").trim()).digest("hex");
}

// What the model is told, as a system instruction, about where requests
// stand. It never sees the deterministic YES and NO exchanges, so without
// this it would say a filed draft is still waiting.
export function requestStatus(approvals: EngineApproval[], generation: number, answerableId: string | null): string | null {
  const answerable = answerableId ? approvals.find((a) => a.id === answerableId) : undefined;
  const question = answerable && answerable.status === "pending" ? presentable(answerable) : null;
  if (question) {
    return `A yes-or-no approval question is waiting for this person:\n${question}\nA plain yes or no answers it automatically, in English or in their language. If they ask about it, answer briefly, in their language.`;
  }
  const latest = proposalsOf(approvals, generation)[0];
  if (!latest) return null;
  // A receipt is read first, whatever the status: it was filed.
  const receipt = latest.outcome?.receipt;
  const state = receipt
    ? isShare(latest)
      ? "the person approved it and it went through"
      : `the person approved it and it was filed, confirmation ${receipt.externalId}${receipt.simulated ? " (a simulated filing)" : ""}`
    : latest.outcome?.lookupsEnded
      ? "the person approved it, Mano could not confirm it went through and has stopped checking, and it will not be sent again without a new approval"
      : latest.status === "approved"
      ? "the person approved it and Mano is checking whether it went through"
      : latest.status === "rejected"
        ? "the person declined it, or it was closed; nothing was sent"
        : latest.status === "pending"
          ? "it was prepared but has not been shown to the person yet"
          : `it can no longer be used (${latest.status}); nothing was sent`;
  return `Latest request Mano prepared: ${latest.purpose}. Status: ${state}. This comes from Mano's own records and is accurate.`;
}
