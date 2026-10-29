// Prepares a benefits renewal and asks for the person's yes. The draft
// goes to Engine only, which freezes the exact request, hashes it and
// holds it pending; nothing leaves Mano until the person texts YES to the
// question rendered from that frozen request.
import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { loadPending, renderQuestion, savePending } from "../lib/pending.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { StorageUnavailable, getKeyValue } from "../lib/storage.js";

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
    const { turnId, generation } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Preparing forms is not available right now. Say so and offer to collect the answers.");
    const kv = await getKeyValue();
    if (!kv) throw new StorageUnavailable("Preparing forms");
    const personId = engine.personId;
    const previous = await loadPending(kv, personId);
    if (previous?.state === "checking" && previous.generation === generation) {
      return {
        status: "waiting_on_previous",
        sent: false,
        note: "An earlier submission is still being confirmed. Do not prepare another; tell the person you are checking on the first one and they can reply YES to check.",
      };
    }
    const payload = { ...input };
    const contentKey = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
    const result = await engine.proposeAction({
      type: "submit",
      recipient: RENEWAL_RECIPIENT,
      purpose: RENEWAL_PURPOSE,
      payload,
      idempotencyKey: `${turnId}:renewal:${contentKey}`,
    });
    if (result.status !== "needs_approval" || !result.approval) {
      return { status: result.status, reason: result.reason ?? "Engine did not hold it for approval.", sent: false };
    }
    // One question waits at a time: the one it replaces can never be
    // answered, so Engine closes it.
    if (previous?.state === "asked" && previous.approvalId !== result.approval.id) {
      await engine.reject(previous.approvalId).catch(() => undefined);
    }
    await savePending(
      kv,
      {
        approvalId: result.approval.id,
        personId,
        generation,
        state: "asked",
        turnId,
        purpose: result.approval.purpose,
        question: renderQuestion(result.approval),
      },
      result.approval.expiresAt,
    );
    return {
      approvalId: result.approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: "The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes.",
    };
  },
});
