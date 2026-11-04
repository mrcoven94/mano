// Prepares stopping what the person shares with an office. Their YES ends
// the office's access at once; the question says it cannot recall what the
// office already received.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine, requireTurn } from "../lib/person.js";
import { holdForYes } from "../lib/propose.js";
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
    const share = (await engine.listShares()).active[0];
    if (!share) return { status: "not_shared", sent: false, note: "Mano is not sharing anything for this person. Say so in one short sentence.", ...stamp };
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
