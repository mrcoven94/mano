// Prepares a benefits renewal for the person's yes. The draft goes to
// Engine only, which freezes the exact request, hashes it and holds it
// pending. The turn's reply then carries the question rendered from that
// frozen request; once Channels reports it reached the person word for
// word, Engine's pointer makes it answerable. Nothing leaves Mano until
// the person texts YES to it.
import { defineTool } from "eve/tools";
import { z } from "zod";

import type { EngineApproval } from "../lib/engine.js";
import { presentsExactly, proposalKey, renderQuestion, waitingProposals } from "../lib/pending.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { placeClaimId } from "../lib/reminders.js";

// Drafts from one message.
const MAX_DRAFTS = 5;

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
    const { turnId, turnAtMs } = requireTurn(ctx);
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
    const payload = { ...input };
    const canonical = (v: Record<string, unknown>) => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
    const sameDraft = (a: EngineApproval) => {
      try {
        return canonical(JSON.parse(a.requestJson).payload ?? {}) === canonical(payload);
      } catch {
        return false;
      }
    };
    // This draft's place among the turn's drafts, claimed per attempt like
    // a reminder's: a replayed turn claims its places again from 0.
    const attempt = ctx.session.turn?.id ?? "attempt";
    let approval: EngineApproval | null = null;
    let outcome: { status: string; reason?: string } | null = null;
    for (let place = 0; place < MAX_DRAFTS && !approval && !outcome; place++) {
      const key = proposalKey(engine.generation, turnId, place);
      const claim = await engine.putTurn(placeClaimId(`draft:${turnId}`, attempt, place), new Date(turnAtMs).toISOString());
      const holder = (await engine.listApprovals()).find((a) => a.idempotencyKey === key) ?? null;
      if (!claim.created) {
        // Another call of this attempt holds this place, unless Eve re-ran
        // this call's step: then the draft there is this one.
        if (holder && sameDraft(holder)) approval = holder.status === "pending" ? holder : null;
        if (holder && sameDraft(holder) && holder.status !== "pending") outcome = { status: holder.status };
        continue;
      }
      // A replay finds the approval its first attempt made: still waiting,
      // it is answered again; closed, nothing new is proposed.
      if (holder) {
        if (holder.status === "pending") approval = holder;
        else outcome = { status: holder.status, reason: "This draft was already answered or closed." };
        break;
      }
      const result = await engine.proposeAction({ type: "submit", recipient: RENEWAL_RECIPIENT, purpose: RENEWAL_PURPOSE, payload, idempotencyKey: key });
      if (result.status === "needs_approval" && result.approval) approval = result.approval;
      else outcome = { status: result.status, reason: result.reason ?? "Engine did not hold it for approval." };
    }
    if (!approval) return { status: outcome?.status ?? "blocked", reason: outcome?.reason ?? "Too many drafts in one message.", sent: false };
    if (!presentsExactly(renderQuestion(approval))) {
      await engine.reject(approval.id).catch(() => undefined);
      return {
        status: "cannot_show_exactly",
        sent: false,
        note: "This draft cannot be shown word for word over text, so it was not put to a yes and nothing was sent. Tell the person plainly, without repeating the details, and offer to help another way.",
      };
    }
    // One question waits at a time: drafts made before this message can no
    // longer be answered, so Engine closes them. Drafts made after it (a
    // replay of an older turn) are never touched.
    const before = (a: EngineApproval) => Date.parse(a.createdAt) < turnAtMs;
    const approvals = await engine.listApprovals();
    const pointed = pointer ? approvals.find((a) => a.id === pointer.approvalId) : undefined;
    if (pointer && pointed && before(pointed)) await engine.clearPointer(pointer.approvalId);
    for (const earlier of waitingProposals(approvals, engine.generation, approval.id).filter(before)) {
      await engine.reject(earlier.id).catch(() => undefined);
    }
    return {
      approvalId: approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: "The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes.",
    };
  },
});
