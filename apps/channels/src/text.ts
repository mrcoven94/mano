// Every word the worker sends on its own, in Mano's voice. The
// introduction says Mano is an automated assistant, not a person
// (AGENTS.md rule 3). The failure reply is the voice guard's safe line.
import { SAFE_REPLY } from "@mano/persona";

export const INTRO_BUBBLE = "Hey, it's Mano. I'm an automated assistant, not a person. I help with benefits, letters and forms.";

export const INTERIM_BUBBLE = "Working on it. I will reply shortly.";

export const FAILURE_BUBBLE = SAFE_REPLY;

export const BUSY_BUBBLE = "Mano is busy right now. Try again later.";

export const OPT_OUT_BUBBLE = "You are unsubscribed from Mano's texts. Send any message to start again.";

export const APPROVAL_RECORDED_BUBBLE = "Recorded. I will follow up when it is decided.";

export function attachmentAck(count: number): string {
  return count === 1
    ? "Got your photo. I will read it and follow up."
    : `Got your ${count} photos. I will read them and follow up.`;
}
