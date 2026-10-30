// Prepares a benefits renewal for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it and holds it
// pending. The turn's reply then carries the question rendered from that
// frozen request; once Channels reports it reached the person word for
// word, Engine's pointer makes it answerable. Nothing leaves Mano until
// the person texts YES to it.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine, requireTurn } from "../lib/person.js";
import { holdForYes } from "../lib/propose.js";

const inputSchema = z.object({
  fullName: z.string().min(1).max(200),
  dateOfBirth: z.string().min(1).max(40),
  address: z.string().min(1).max(300),
  phone: z.string().min(1).max(40),
  householdSize: z.number().int().min(1).max(30),
  monthlyIncome: z.number().min(0),
});

export const RENEWAL_RECIPIENT = "sandbox-agency-portal";
export const RENEWAL_PURPOSE = "Food benefits renewal in the sandbox agency portal";

export default defineTool({
  description:
    "Prepare the person's benefits renewal with their household details. Call it once you have every field; ask for what is missing first. It sends nothing: the person gets the exact version to approve with YES.",
  inputSchema,
  label: {
    start: () => "Prepare the renewal",
  },
  async execute(input, ctx) {
    const turn = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Preparing forms is not available right now. Say so and offer to collect the answers.");
    const held = await holdForYes(engine, ctx, turn, {
      type: "submit",
      recipient: RENEWAL_RECIPIENT,
      purpose: RENEWAL_PURPOSE,
      payload: { ...input },
    });
    if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false };
    return {
      approvalId: held.approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: "The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes.",
    };
  },
});
