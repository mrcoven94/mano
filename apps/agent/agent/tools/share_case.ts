// Prepares sharing the person's renewal with their caseworker's office. The
// approval question names the office and every value that goes; nothing is
// shared until the person texts YES to it.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine, requireTurn } from "../lib/person.js";
import { holdForYes } from "../lib/propose.js";
import { SHARE_FORM, SHARE_ORG, SHARE_PURPOSE, grantDraft, renewalDetails, shareCaseId } from "../lib/sharing.js";

export default defineTool({
  description:
    "Prepare sharing the person's food benefits renewal with their caseworker's office, when they ask for that. It either says what is missing or holds the exact version for the person's YES. It shares nothing.",
  inputSchema: z.object({}),
  label: {
    start: () => "Prepare sharing the renewal",
  },
  async execute(_input, ctx) {
    const turn = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Sharing is not available right now. Say so, and that nothing was shared.");
    const stamp = { form: SHARE_FORM, turn: turn.turnId };
    const [{ active, revoked }, profile, deadlines] = await Promise.all([engine.listShares(), engine.getProfile(), engine.listDeadlines()]);
    if (active.some((s) => s.recipient === SHARE_ORG && s.purpose === SHARE_PURPOSE)) {
      return { status: "already_shared", sent: false, note: "This office can already see their renewal. Say so in one short sentence.", ...stamp };
    }
    const details = renewalDetails(profile, deadlines);
    if (!details.some((d) => d.label === "Name")) {
      return { status: "needs_answer", sent: false, question: "What name should your caseworker see on your renewal?", note: "Ask this one question, save the answer with update_profile, then call share_case again.", ...stamp };
    }
    const round = revoked.filter((r) => r.recipient === SHARE_ORG).length;
    const held = await holdForYes(engine, ctx, turn, grantDraft(shareCaseId(engine.personId, round), details));
    if (!held.held) return { status: held.status, note: held.note, reason: held.reason, sent: false, ...stamp };
    return {
      approvalId: held.approval.id,
      status: "waiting_for_yes",
      sent: false,
      note: "The exact approval question goes to the person with your reply. Do not ask it yourself; say in one short sentence that it is ready for their yes.",
      ...stamp,
    };
  },
});
