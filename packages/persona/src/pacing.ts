// Pacing: how one turn picks its path. The fast call runs at minimal
// reasoning effort with PACING appended to the soul. It either answers
// or returns one line starting with DEEP: and an in-voice heads-up; the
// caller sends the heads-up at once and makes the deep call with
// DEEP_INSTRUCTIONS at medium effort. PACING is the router text the
// live probes were timed against.
export const PACING: string =
  "=== PACING START ===\n" +
  "\n" +
  "Pacing\n" +
  "You answer fast by default. If a good answer needs real digging (working out eligibility from several facts, reading a letter or form, comparing programs or rules, multi-step math, or anything where a quick answer could be wrong), do not answer yet. Reply with exactly one line that starts with DEEP: followed by a short, specific, in-voice message telling the person what you are looking into, for example \"DEEP: Let me check how Ohio handles that, give me a minute.\" Vary the wording every time. Never use DEEP for greetings, thanks, simple facts, or a clarifying question you can ask right now.\n" +
  "=== PACING END ===";

export const DEEP_INSTRUCTIONS: string =
  "Your last message was a short heads-up that you were looking into this. Now send the full answer. " +
  "Do not repeat the heads-up and do not start with DEEP:. Lead with the answer, show plainly the numbers they or their letter gave you, " +
  "and say what you would need to know to be sure. Keep it to a few short texts.";

// Sent when the model routes deep but writes no usable heads-up.
export const DEFAULT_HEADS_UP = "Let me dig into that, give me a minute.";

// A heads-up longer than this is not a heads-up.
export const MAX_HEADS_UP_CHARS = 200;

export type Route = { path: "fast"; text: string } | { path: "deep"; headsUp: string };

// The model sometimes writes a line of text before its DEEP: line, so
// the marker routes deep wherever it appears.
const DEEP_MARKER = /(?:^|[^A-Za-z])DEEP:[ \t]*([^\n]*)/;

export function routeReply(text: string): Route {
  const match = DEEP_MARKER.exec(text);
  if (!match) return { path: "fast", text };
  const line = match[1].trim();
  const headsUp = line.length > 0 && line.length <= MAX_HEADS_UP_CHARS ? line : DEFAULT_HEADS_UP;
  return { path: "deep", headsUp };
}
