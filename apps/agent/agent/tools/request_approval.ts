// The one gate for anything that leaves Mano. Asks the person a plain
// yes-or-no question over text, waits durably for their answer, and
// returns who approved and when. Anything unclear, withdrawn, or asked
// where no person can answer fails closed: approved is false.
import { defineWorkflowTool, type ToolInputResponse } from "eve/tools";
import { z } from "zod";

import { parseDecision } from "../lib/decision.js";

const inputSchema = z.object({
  action: z.string().min(1).max(100).describe("Short label for what needs approval, like submitting a renewal."),
  detail: z.string().min(1).max(1000).describe("The exact what and where: recipient, purpose, and document version."),
});

type ApprovalInput = z.infer<typeof inputSchema>;

export interface ApprovalResult {
  approved: boolean;
  reason: "yes" | "no" | "unclear" | "withdrawn" | "unavailable";
  decidedBy: string | null;
  decidedAt: string | null;
  answerText: string | null;
}

function decide(answer: ToolInputResponse): { approved: boolean; reason: ApprovalResult["reason"]; answerText: string | null } {
  if (answer.status === "cancelled") return { approved: false, reason: "withdrawn", answerText: null };
  if (answer.status === "unavailable") return { approved: false, reason: "unavailable", answerText: null };
  if (answer.optionId === "yes") return { approved: true, reason: "yes", answerText: answer.text ?? "yes" };
  if (answer.optionId === "no") return { approved: false, reason: "no", answerText: answer.text ?? "no" };
  const decision = answer.text ? parseDecision(answer.text) : null;
  if (decision === "yes") return { approved: true, reason: "yes", answerText: answer.text ?? null };
  if (decision === "no") return { approved: false, reason: "no", answerText: answer.text ?? null };
  return { approved: false, reason: "unclear", answerText: answer.text ?? null };
}

async function recordDecision(input: {
  answer: ToolInputResponse;
  fallbackBy: string | null;
}): Promise<ApprovalResult> {
  "use step";
  const { approved, reason, answerText } = decide(input.answer);
  const responder =
    input.answer.status === "answered" ? (input.answer.responder?.principalId ?? null) : null;
  return {
    approved,
    reason,
    decidedBy: approved || reason === "no" ? (responder ?? input.fallbackBy) : null,
    decidedAt: approved || reason === "no" ? new Date().toISOString() : null,
    answerText,
  };
}

export default defineWorkflowTool({
  description:
    "Ask the person to approve one outside action as a plain yes-or-no question. Call it before anything leaves Mano (submitting, sharing, sending to someone else). State the exact recipient, purpose, and version in detail. The call waits for their answer; unclear or missing answers come back unapproved.",
  inputSchema,
  label: {
    start: ({ action }) => `Ask approval: ${action}`,
  },
  async execute(_input: ApprovalInput, ctx) {
    "use workflow";
    const answer = await ctx.ask({
      prompt: `${_input.detail}\n\nReply YES to approve or NO to cancel.`,
      display: "confirmation",
      options: [
        { id: "yes", label: "Yes", style: "primary" },
        { id: "no", label: "No", style: "danger" },
      ],
      allowFreeform: true,
    });
    return recordDecision({
      answer,
      fallbackBy: ctx.session.auth.current?.principalId ?? null,
    });
  },
});
