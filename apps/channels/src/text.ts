// Every word the worker sends on its own. Plain copy, no tagline. The
// introduction identifies Mano as an automated assistant (AGENTS.md rule 3).

export const INTRO_BUBBLE = "Hi, I'm Mano, an automated assistant. I can help with benefits, forms and letters.";

export const INTERIM_BUBBLE = "Working on it. I will reply shortly.";

export const FAILURE_BUBBLE = "Sorry, that did not go through. Try again in a bit.";

export const BUSY_BUBBLE = "Mano is busy right now. Try again later.";

export const OPT_OUT_BUBBLE = "You are unsubscribed from Mano's texts. Send any message to start again.";

export const APPROVAL_RECORDED_BUBBLE = "Recorded. I will follow up when it is decided.";

export function attachmentAck(count: number): string {
  return count === 1
    ? "Got your photo. I will read it and follow up."
    : `Got your ${count} photos. I will read them and follow up.`;
}
