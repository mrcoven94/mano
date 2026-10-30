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

export function attachmentAck(count: number): string {
  return count === 1
    ? "Got your photo. I will read it and follow up."
    : `Got your ${count} photos. I will read them and follow up.`;
}
