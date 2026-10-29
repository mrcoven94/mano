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

const AGENT_KEY_PREFIX = "agent:";

// Every proposal gets its own key. Engine closes an approval by closing
// every approval under its key, so two proposals never share one; the
// turn ID in the key tells which turn proposed it.
export function proposalKey(turnId: string): string {
  return `${AGENT_KEY_PREFIX}${turnId}:${randomUUID().slice(0, 8)}`;
}

function isAgentProposal(approval: EngineApproval): boolean {
  return approval.idempotencyKey.startsWith(AGENT_KEY_PREFIX);
}

// The approval this turn proposed and Engine still holds, newest first.
export function proposedIn(approvals: EngineApproval[], turnId: string): EngineApproval | null {
  return (
    approvals
      .filter((a) => a.status === "pending" && a.idempotencyKey.startsWith(`${AGENT_KEY_PREFIX}${turnId}:`))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

// Agent proposals still waiting that are not the answerable one.
export function waitingProposals(approvals: EngineApproval[], exceptId: string | null = null): EngineApproval[] {
  return approvals.filter((a) => a.status === "pending" && isAgentProposal(a) && a.id !== exceptId);
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
