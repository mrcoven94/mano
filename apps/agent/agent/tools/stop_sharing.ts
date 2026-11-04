// Prepares stopping what the person shares with an office. Their YES ends
// the office's access at once; the question says it cannot recall what the
// office already received. A share question still waiting is closed first,
// so no later YES grants what they just asked to stop. While a share they
// already approved has no outcome, Mano does not say nothing is shared.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { isShareGrant } from "../lib/pending.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { holdForYes, rejected } from "../lib/propose.js";
import { SHARE_FORM, revokeDraft } from "../lib/sharing.js";

export default defineTool({
  description:
    "Prepare stopping what the person shares with their caseworker's office, when they ask for that. It holds the exact version for the person's YES and stops nothing yet.",
  inputSchema: z.object({}),
  label: {
    start: () => "Prepare to stop sharing",
  },
  async execute(_input, ctx) {
    const turn = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Stopping is not available right now. Say so, and that sharing has not changed.");
    const stamp = { form: SHARE_FORM, turn: turn.turnId };
    const [{ active }, approvals] = await Promise.all([engine.listShares(), engine.listApprovals()]);
    const grants = approvals.filter(isShareGrant);
    const waiting = grants.filter((a) => a.status === "pending");
    for (const approval of waiting) {
      if (!(await rejected(engine, approval.id))) {
        return { status: "not_closed", sent: false, note: "Mano could not close the share question waiting for the person, so a YES to it would still share. Tell them plainly not to answer YES and to ask again in a moment.", ...stamp };
      }
      await engine.clearPointer(approval.id);
    }
    const share = active[0];
    if (!share) {
      if (grants.some((a) => a.status === "approved" && !a.outcome?.receipt && a.outcome?.attempt !== "failed")) {
        return { status: "earlier_share_unresolved", sent: false, note: "The share the person approved is still being confirmed, so it may have reached the office. Tell them that plainly, that you cannot stop it until it settles, and to ask again in a few minutes.", ...stamp };
      }
      if (waiting.length > 0) {
        return { status: "question_closed", sent: false, note: "The share question that was waiting is closed, so a YES will not share anything, and nothing was shared. Say so in one short sentence.", ...stamp };
      }
      return { status: "not_shared", sent: false, note: "Mano is not sharing anything for this person. Say so in one short sentence.", ...stamp };
    }
    const held = await holdForYes(engine, ctx, turn, revokeDraft(share));
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
