// The keywords a person texts to stop Mano and to start it again. This
// module only matches them; the worker decides what a match does.
// Approvals are not answered here: Engine owns them.

// STOP-family keywords. The provider enforces recipient opt-outs; on top
// of that the worker goes quiet for the conversation, per the provider's
// rule that an automation must stop when asked and wait for re-engagement.
const OPT_OUT_KEYWORDS = new Set(["STOP", "QUIT", "CANCEL", "UNSUBSCRIBE", "END", "STOPALL"]);

export function isOptOut(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(text.trim().toUpperCase());
}

// Clear re-opt-in keywords. After a STOP whose own timestamp is unknown,
// these re-engage at once; any other message waits out a short window.
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);

export function isOptIn(text: string): boolean {
  return OPT_IN_KEYWORDS.has(text.trim().toUpperCase());
}
