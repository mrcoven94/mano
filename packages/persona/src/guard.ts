// Deterministic voice guard. Runs on every outgoing text before it is
// sent. It always returns sendable text: dashes and markdown are
// rewritten in place, a self-description that names a model or
// provider becomes SELF_DESCRIPTION, any other sentence that names one
// is dropped, and a reply with nothing left becomes SAFE_REPLY.
// Callers log the change names, never the text. guardReply is
// idempotent, so a replayed send carries the same bytes.

export const SELF_DESCRIPTION = "I'm Mano, an automated assistant.";

// Sent when a reply has nothing sendable left, and when the model fails.
export const SAFE_REPLY = "Sorry, I hit a snag on my end and lost that one. Can you send it again in a minute?";

export type GuardChange = "route-marker" | "markdown" | "dash" | "self-description" | "provider-name" | "empty";

export interface GuardResult {
  text: string;
  changes: GuardChange[];
}

// Names that are also English words match only in their capitalized
// form, so "a spark of hope" and "the museum" pass.
const NAMES_EXACT_CASE = ["Muse", "Spark", "Meta", "Llama", "LLaMA", "Claude", "Gemini", "Bard", "Mistral", "DeepSeek", "Grok", "Copilot"];
const NAMES_ANY_CASE = ["meta ai", "openai", "chatgpt", "gpt", "anthropic", "google ai", "deepmind", "language model", "llms?", "ai model"];

const EXACT_PATTERN = new RegExp(`\\b(?:${NAMES_EXACT_CASE.join("|")})\\b`);
const ANY_PATTERN = new RegExp(`\\b(?:${NAMES_ANY_CASE.join("|")})\\b`, "i");

export function containsProviderName(text: string): boolean {
  return EXACT_PATTERN.test(text) || ANY_PATTERN.test(text);
}

// A sentence that names a provider and talks about the speaker is a
// self-description: "I'm Muse Spark!", "This is ChatGPT", "Mano runs on Llama".
const SELF_REFERENCE = /\b(?:i|i'm|i’m|im|me|my|myself|mano|this is|you'?re (?:talking|chatting|texting) (?:to|with))\b/i;

const DASHES = "‒–—―";

export function stripMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*```.*$/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => (url.includes(label) ? url : `${label} (${url})`))
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_m, line: string) => endSentence(line))
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^[ \t]*[-*+•◦▪‣○●][ \t]+(.+)$/gm, (_m, line: string) => endSentence(line))
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\*\*/g, "");
}

// A bullet or header loses its line break once bubbles are joined, so
// it keeps its own sentence end.
function endSentence(line: string): string {
  return /[.!?:;,…]["”’)]?$/.test(line) ? line : `${line}.`;
}

export function removeDashes(text: string): string {
  return text
    .replace(new RegExp(`(\\d)[ \\t]*(?:[${DASHES}−]|[ \\t]-[ \\t])[ \\t]*(\\d)`, "g"), "$1 to $2")
    .replace(new RegExp(`[ \\t]*(?:[${DASHES}]|--+)[ \\t]*`, "g"), ", ")
    .replace(/(\S)[ \t]+-[ \t]+(?=\S)/g, "$1, ")
    .replace(/,[ \t]*([,.!?;:])/g, "$1")
    .replace(/^[ \t]*,[ \t]*/gm, "")
    .replace(/[ \t]*,[ \t]*$/gm, "");
}

// Rewrites or drops every sentence that names a model or provider.
function removeProviderNames(text: string): { text: string; selfDescribed: boolean } {
  let selfDescribed = false;
  const kept: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+/)) {
    if (!containsProviderName(sentence)) {
      kept.push(sentence);
    } else if (SELF_REFERENCE.test(sentence) && !selfDescribed) {
      selfDescribed = true;
      kept.push(SELF_DESCRIPTION);
    }
  }
  return { text: kept.join(" "), selfDescribed };
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function guardReply(raw: string): GuardResult {
  const changes: GuardChange[] = [];
  let text = raw;
  const unrouted = text.replace(/(^|[^A-Za-z])DEEP:[ \t]*/g, "$1 ");
  if (unrouted !== text) changes.push("route-marker");
  text = unrouted;
  const unmarked = stripMarkdown(text);
  if (unmarked !== text) changes.push("markdown");
  text = unmarked;
  const undashed = removeDashes(text);
  if (undashed !== text) changes.push("dash");
  text = undashed;
  if (containsProviderName(text)) {
    const named = removeProviderNames(text);
    changes.push(named.selfDescribed ? "self-description" : "provider-name");
    text = named.text;
  }
  text = tidy(text);
  if (!/[\p{L}\p{N}]/u.test(text)) {
    changes.push("empty");
    text = SAFE_REPLY;
  }
  return { text, changes };
}
