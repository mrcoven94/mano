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
import { createHash, randomUUID } from "node:crypto";

import { guardReply } from "@mano/persona";

import type { EngineApproval } from "./engine.js";

const LABELS: Record<string, string> = {
  fullName: "Name",
  dateOfBirth: "Date of birth",
  address: "Address",
  phone: "Phone",
  householdSize: "Household size",
  monthlyIncome: "Monthly income",
};

// Every proposal gets its own key. Engine closes an approval by closing
// every approval under its key, so two proposals never share one. The
// key names the conversation generation and the turn that proposed it,
// so the agent only ever reads proposals of the current conversation.
function prefix(generation: number): string {
  return `agent:g${generation}:`;
}

export function proposalKey(generation: number, turnId: string): string {
  return `${prefix(generation)}${turnId}:${randomUUID().slice(0, 8)}`;
}

// The agent's proposals in this conversation, newest first.
export function proposalsOf(approvals: EngineApproval[], generation: number): EngineApproval[] {
  return approvals
    .filter((a) => a.idempotencyKey.startsWith(prefix(generation)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// The approval this turn proposed and Engine still holds.
export function proposedIn(approvals: EngineApproval[], generation: number, turnId: string): EngineApproval | null {
  return (
    proposalsOf(approvals, generation).find(
      (a) => a.status === "pending" && a.idempotencyKey.startsWith(`${prefix(generation)}${turnId}:`),
    ) ?? null
  );
}

// Proposals of this conversation still waiting that are not the answerable one.
export function waitingProposals(approvals: EngineApproval[], generation: number, exceptId: string | null = null): EngineApproval[] {
  return proposalsOf(approvals, generation).filter((a) => a.status === "pending" && a.id !== exceptId);
}

export function renderQuestion(approval: Pick<EngineApproval, "purpose" | "recipient" | "requestJson">): string {
  let payload: Record<string, unknown> = {};
  try {
    const frozen = JSON.parse(approval.requestJson) as { payload?: Record<string, unknown> };
    payload = frozen.payload ?? {};
  } catch {
    // Unreadable frozen request: the question shows purpose and recipient only.
  }
  const order = (k: string) => {
    const i = Object.keys(LABELS).indexOf(k);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const lines = Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .sort(([a], [b]) => order(a) - order(b))
    .map(([k, v]) => `${LABELS[k] ?? k}: ${v}`);
  // One paragraph: the text line flattens line breaks, so fields are
  // separated in the sentence itself.
  return [
    `Ready to send: ${approval.purpose} (to ${approval.recipient}).`,
    lines.length > 0 ? `${lines.join("; ")}.` : "",
    "Reply YES to send exactly this, or NO to stop.",
  ]
    .filter(Boolean)
    .join(" ");
}

// True when the text line would carry the question word for word: the
// shared voice guard (which drops any sentence naming a model or
// provider, and rewrites dashes and markdown) leaves it unchanged, and it
// holds no link for the link check to strip. Anything else cannot be put
// to a YES. Channels runs the same check before sending.
export function presentsExactly(question: string): boolean {
  return guardReply(question).text === question && !/https?:\/\/|www\./i.test(question);
}

// What Channels reports after it sent a question: SHA-256 (hex) of the
// question with runs of whitespace collapsed to one space, since the
// text line may split it into bubbles at spaces. Channels computes the
// same hash over what it sent.
export function presentationHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

// What the model is told, as a system instruction, about where requests
// stand. It never sees the deterministic YES and NO exchanges, so without
// this it would say a filed draft is still waiting.
export function requestStatus(approvals: EngineApproval[], generation: number, answerableId: string | null): string | null {
  const answerable = answerableId ? approvals.find((a) => a.id === answerableId) : undefined;
  if (answerable && answerable.status === "pending") {
    return `A yes-or-no approval question is waiting for this person:\n${renderQuestion(answerable)}\nA plain YES or NO answers it automatically. If they ask about it, answer briefly.`;
  }
  const latest = proposalsOf(approvals, generation)[0];
  if (!latest) return null;
  const state =
    latest.status === "approved"
      ? latest.outcome?.attempt === "done"
        ? "the person approved it and it was filed"
        : "the person approved it and Mano is checking whether it went through"
      : latest.status === "rejected"
        ? "the person declined it, or it was closed; nothing was sent"
        : latest.status === "pending"
          ? "it was prepared but has not been shown to the person yet"
          : `it can no longer be used (${latest.status}); nothing was sent`;
  return `Latest request Mano prepared: ${latest.purpose}. Status: ${state}. This comes from Mano's own records and is accurate.`;
}
