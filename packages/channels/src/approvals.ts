// Text approvals, for later when the engine sends them: a short summary
// and a code, answered with "YES <code>" or "NO <code>". This module only
// parses the reply; the engine's gateway decides.

export interface ApprovalReply {
  decision: "yes" | "no";
  code: string;
}

export function parseApprovalReply(text: string): ApprovalReply | null {
  const match = text.trim().match(/^(yes|no)\s+([A-Za-z0-9-]{4,32})$/i);
  if (!match) return null;
  return { decision: match[1].toLowerCase() === "yes" ? "yes" : "no", code: match[2] };
}

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
