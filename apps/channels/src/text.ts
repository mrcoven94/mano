// Every word the worker sends on its own, in Mano's voice. The
// introduction says Mano is an automated assistant, not a person
// (AGENTS.md rule 3). The failure reply is the voice guard's safe line.
// Every reply sent without the model (busy, over a limit, failure)
// carries SAFETY_LINE, so crisis help never depends on detection.
import { INTRO_LINE, SAFE_REPLY, SAFETY_LINE } from "@mano/persona";

export const INTRO_BUBBLE = INTRO_LINE;

export const INTERIM_BUBBLE = "Working on it. I will reply shortly.";

export const FAILURE_BUBBLE = SAFE_REPLY;

export const BUSY_BUBBLE = `I'm busy right now, try me again later. ${SAFETY_LINE}`;

export { OPT_OUT_BUBBLE } from "@mano/channels";

export const APPROVAL_RECORDED_BUBBLE = "Recorded. I will follow up when it is decided.";

// Delete by text (LAP-1230). The ask names the exact word, the window and
// that it cannot be undone. The done line says the next text starts over;
// the pending one says nothing from before is used while it finishes,
// which holds because the agent stays off until every part is confirmed.
export const DELETE_ASK_BUBBLE =
  "To delete everything Mano has about you, send DELETE again in the next 10 minutes. This cannot be undone.";

export const DELETE_DONE_BUBBLE = "Done. Everything Mano had about you is deleted. Text me anytime to start fresh.";

export const DELETE_PENDING_BUBBLE =
  "Deleting everything Mano has about you. It is still finishing, and nothing from before will be used. Text me anytime to start fresh.";
