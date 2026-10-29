// Prepares a benefits renewal for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it and holds it
// pending. The turn's reply then carries the question rendered from that
// frozen request; once Channels reports it reached the person word for
// word, Engine's pointer makes it answerable. Nothing leaves Mano until
// the person texts YES to it.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { presentsExactly, proposalKey, renderQuestion, waitingProposals } from "../lib/pending.js";
import { personEngine, requireTurn } from "../lib/person.js";

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
    const { turnId } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Preparing forms is not available right now. Say so and offer to collect the answers.");
    const pointer = await engine.getPointer();
    if (pointer) {
      const answerable = await engine.approval(pointer.approvalId);
      if (answerable?.status === "approved") {
        return {
          status: "waiting_on_previous",
          sent: false,
          note: "An earlier submission is still being confirmed. Do not prepare another; tell the person you are checking on the first one and they can reply YES to check.",
        };
      }
    }
    const result = await engine.proposeAction({
      type: "submit",
      recipient: RENEWAL_RECIPIENT,
      purpose: RENEWAL_PURPOSE,
      payload: { ...input },
      idempotencyKey: proposalKey(turnId),
    });
    if (result.status !== "needs_approval" || !result.approval) {
      return { status: result.status, reason: result.reason ?? "Engine did not hold it for approval.", sent: false };
    }
    if (!presentsExactly(renderQuestion(result.approval))) {
      await engine.reject(result.approval.id).catch(() => undefined);
      return {
        status: "cannot_show_exactly",
        sent: false,
        note: "This draft cannot be shown word for word over text, so it was not put to a yes and nothing was sent. Tell the person plainly, without repeating the details, and offer to help another way.",
      };
    }
    // One question waits at a time: earlier proposals, shown or not, can
    // never be answered now, so Engine closes them.
    if (pointer) await engine.clearPointer(pointer.approvalId);
    for (const earlier of waitingProposals(await engine.listApprovals(), result.approval.id)) {
      await engine.reject(earlier.id).catch(() => undefined);
    }
    return {
      approvalId: result.approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: "The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes.",
    };
  },
});
