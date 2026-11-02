// finalizeReply: the one place a reply becomes the bubbles Mano sends.
// The runner uses it for every model answer and fixed reply, and Quality
// can run the same function on any text. In order: the voice guard, the
// link check on the whole text and again on each bubble, one bubble per
// line, the send-time guard on each bubble, and on a crisis turn the
// crisis line first, once, with only the bubbles after it capped.
import { CRISIS_LINE, CRISIS_LINE_ES, SAFE_REPLY, guardReply, holdCrisisLines, type GuardChange } from "@mano/persona";
import { MAX_BUBBLES, MAX_BUBBLE_CHARS, splitBubbles } from "./bubbles.js";
import { stripBlockedLinks, type LinkChecker } from "./links.js";

export interface FinalizeOptions {
  // The model IDs this deployment calls, so a reply naming one is caught.
  modelIds?: readonly string[];
  // A crisis turn: the crisis line goes first and the cap never drops it.
  crisis: boolean;
  checker: LinkChecker;
  // The crisis line in the person's language. Defaults to English.
  crisisLine?: string;
}

export interface FinalReply {
  bubbles: string[];
  // Links the check removed.
  removed: number;
  // The guard rules that fired, for logging. Never the text.
  changes: GuardChange[];
}

export async function finalizeReply(text: string, opts: FinalizeOptions): Promise<FinalReply> {
  const line = opts.crisisLine ?? CRISIS_LINE;
  if (opts.crisis && text.trim().length === 0) return { bubbles: [line], removed: 0, changes: [] };
  const changes = new Set<GuardChange>();
  const guard = (t: string): string => {
    const guarded = guardReply(t, { modelIds: opts.modelIds ?? [] });
    for (const change of guarded.changes) changes.add(change);
    return guarded.text;
  };
  // The guard runs before splitting: bullets and headers are line-based.
  const first = await stripBlockedLinks(guard(text), opts.checker);
  let removed = first.removed;
  const split: string[] = [];
  for (const bubble of splitBubbles(first.text)) {
    // The splitter never breaks a word, so this normally finds nothing; it
    // keeps a future extraction gap from shipping an unchecked link.
    const rechecked = await stripBlockedLinks(bubble, opts.checker);
    removed += rechecked.removed;
    split.push(...(rechecked.text.length <= MAX_BUBBLE_CHARS ? [rechecked.text] : splitBubbles(rechecked.text)));
  }
  const capped = split.length <= MAX_BUBBLES ? split : splitBubbles(split.join(" "));
  const voiced = capped.map(guard);
  if (!opts.crisis) return { bubbles: voiced, removed, changes: [...changes] };
  // The model may have written a crisis line into its own text.
  const rest = splitBubbles(voiced.join("\n").split(CRISIS_LINE).join("\n").split(CRISIS_LINE_ES).join("\n"))
    .map(guard)
    .filter((t) => t !== SAFE_REPLY);
  return { bubbles: holdCrisisLines(rest, line).slice(0, MAX_BUBBLES), removed, changes: [...changes] };
}

// The confirmation sent when someone texts STOP. Exported so Quality and
// other channels send the same words.
export const OPT_OUT_BUBBLE = "You are unsubscribed from Mano's texts. Send any message to start again.";
