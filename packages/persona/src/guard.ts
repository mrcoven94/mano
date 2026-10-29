// Deterministic voice guard. Runs on every outgoing text before it is
// sent. It always returns sendable text: dashes and markdown are
// rewritten in place, a self-description that names a model or
// provider becomes SELF_DESCRIPTION, any other sentence that names one
// is dropped, and a reply with nothing left becomes SAFE_REPLY.
// Callers log the change names, never the text. guardReply is
// idempotent, so a replayed send carries the same bytes.

import { SAFETY_LINE } from "./crisis.js";

export const SELF_DESCRIPTION = "I'm Mano, an automated assistant.";

// Sent when a reply has nothing sendable left, and when the model fails.
// Like every reply sent without the model, it carries SAFETY_LINE.
export const SAFE_REPLY = `Sorry, I hit a snag on my end and lost that one. Can you send it again in a minute? ${SAFETY_LINE}`;

export type GuardChange = "route-marker" | "markdown" | "dash" | "self-description" | "provider-name" | "empty";

export interface GuardResult {
  text: string;
  changes: GuardChange[];
}

// Always a model or provider, in any case. Model IDs match by shape
// (muse-spark-1.3, llama3, gpt-4o), and callers add their configured IDs.
const ALWAYS_NAMES = ["muse spark", "meta ai", "openai", "chatgpt", "gpt", "anthropic", "google ai", "deepmind", "deepseek", "language model", "llms?", "ai model"];
const ALWAYS_PATTERN = new RegExp(`\\b(?:${ALWAYS_NAMES.join("|")})\\b`, "i");
const MODEL_ID_PATTERN = /\b(?:muse|spark|glimmer|llama|gpt|claude|gemini|mistral|grok)[-_. ]?(?:[a-z]+[-_. ]?)?\d[\w.-]*/i;

// Words that only name a model or product are a leak in any case,
// anywhere: a benefits reply never needs them. Words that are also
// people's names or ordinary words (claude, gemini, nova, spark, meta,
// bard) are in AI_NAMES below and count only inside identity
// constructions, so "your caseworker Claude" and "I'm a Gemini" pass. A sentence that also makes an identity
// statement always leaks. Otherwise only these exact idioms are exempt,
// each covered by a test.
const WORD_NAMES = ["muse", "glimmer", "llama", "mistral", "grok", "copilot"];
const WORD_PATTERN = new RegExp(`\\b(?:${WORD_NAMES.join("|")})\\b`, "i");
const IDENTITY_STATEMENT =
  /\b(?:i am|i'm|i’m|im|my name is|this is|powered by|built (?:on|by)|made by|trained by|runs? on|running on|based on|models?|assistant from)\b/i;
const ORDINARY_PHRASES = /\b(?:spark of hope|glimmer of hope|muse (?:on|about))\b/gi;

function escapePattern(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A configured ID also matches without its -contributor suffix, and
// with any separators between its parts ("muse spark 1.3").
function idPattern(modelIds: readonly string[]): RegExp | null {
  const ids = [...new Set(modelIds.flatMap((id) => [id, id.replace(/-contributor$/, "")]).filter((id) => id.length > 0))];
  if (ids.length === 0) return null;
  const loose = ids.map((id) => id.split(/[-_.\s]+/).map(escapePattern).join("[-_.\\s\\u2010-\\u2015]*"));
  return new RegExp(`(?<![\\w.-])(?:${loose.join("|")})(?![\\w-])`, "i");
}

// Mano describes itself one way only. Two rules decide a sentence that
// identifies the assistant as anything but Mano:
// 1. A name from AI_NAMES, a finite list, in any case, inside an
//    identity construction about the assistant ("I'm X", "this is X",
//    "X made me", "I use X to answer"). Anywhere else a listed company
//    passes, so "Walmart and Amazon accept SNAP online" is still help.
// 2. For names not on the list, only a capitalized "I'm X", "my name is
//    X", or the assistant itself made, built or created by X.
// Benefits program names that contain a listed name are exempt.
const AI_NAMES = [
  "meta", "muse", "spark", "glimmer", "llama", "openai", "chatgpt", "gpt", "google", "gemini", "bard", "anthropic",
  "claude", "microsoft", "copilot", "bing", "amazon", "alexa", "nova", "apple", "siri", "mistral", "deepseek", "grok", "xai",
];
const NAME = `(?:${AI_NAMES.join("|")})`;
const FILLER = "(?:(?:a|an|the|your|just|actually) )?(?:(?:ai|virtual|voice|digital|assistant|model|bot|chatbot|version|helper) )*";
const SELF = "(?:i|i was|i am|i'm|i’m|im|mano|mano is|mano was)";
const MAKER = "(?:made|built|created|developed|trained|powered|designed|programmed|engineered)";
const ASSISTANT_WORD = "(?:ai|virtual|voice|digital|assistant|model|bot|chatbot|version|helper)";
const IDENTITY_WITH_NAME = [
  // "I'm Claude", "my name is the Spark", but not "I'm a Gemini": a bare
  // "a" or "an" counts only with an assistant word ("I'm a Gemini model").
  `\\b(?:i am|i'm|i’m|im|my name is|you(?:'re|’re| are) (?:talking|chatting|texting) (?:to|with)) (?:(?:the|your|just|actually) )?(?:${ASSISTANT_WORD} )*${NAME}\\b`,
  `\\b(?:i am|i'm|i’m|im) (?:a|an) (?:${ASSISTANT_WORD} )*${NAME}(?:['’]s)? (?:ai |virtual )?(?:assistant|model|bot|chatbot|helper)\\b`,
  `^\\s*(?:powered|built|made|created|developed|trained) (?:by|on) ${FILLER}${NAME}\\b`,
  `\\b(?:i am|i'm|i’m|im|this is) (?:a|an|the|your) (?:[\\w-]+ )?(?:assistant|model|bot|chatbot|helper) (?:from|by|made by|built by|of) ${FILLER}${NAME}\\b`,
  `\\bthis is ${FILLER}${NAME}\\b(?!['’]s (?!(?:ai |virtual )?(?:assistant|model|bot|chatbot)\\b))`,
  `\\b${SELF}(?: (?:an?|the) (?:[\\w-]+ )?(?:assistant|ai|model|bot|chatbot))? ${MAKER} (?:by|on|at) ${FILLER}${NAME}\\b`,
  `\\b(?:i run|i am based|i'm based|i’m based|im based|mano runs|mano is based|mano was built) on ${FILLER}${NAME}\\b`,
  `\\b(?:i|mano) (?:use|uses) ${NAME} (?:to|for) (?:answer|answers|reply|replies|respond|think|talk|write)\\b`,
  `\\b${NAME} (?:made|built|created|developed|trained|powers|runs|designed) (?:me|mano)\\b`,
  `\\bmy (?:maker|creator|developer|provider|company|model) is ${FILLER}${NAME}\\b`,
  `\\b(?:i am|i'm|i’m|im|this is|my name is)(?: (?:a|an|the|your))? ${NAME}['’]s (?:ai |virtual )?(?:assistant|model|bot|chatbot)\\b`,
].map((source) => new RegExp(source, "i"));
const PROGRAM_NAMES = /\bapple health\b/gi;

const OTHER_SELF = [
  /\bi(?: was| am|'m|’m)(?: (?:an?|the) (?:[\w-]+ )?(?:assistant|ai|model|bot|chatbot))? (?:developed|built|made|created|trained|designed|programmed|powered|engineered) (?:by|at|on)\s+(?!mano\b)\S/i,
  /\bmy name is\s+(?!mano\b)\S/i,
  // Case-sensitive on purpose: the name after it is capitalized.
  // An article counts only before an assistant word, so "I'm a
  // Medicaid expert" and "I'm a Gemini" pass.
  /\b[Ii](?:'m|’m| am) (?:(?:an?|the) (?:(?:[Aa][Ii]|AI|assistant|model|bot|chatbot|version|virtual) )+|(?:(?:[Aa][Ii]|AI|assistant|model|bot|chatbot|version) )*)(?:called |named )?(?!Mano\b)[A-Z]/,
];

function selfIdentifiesAsOther(sentence: string): boolean {
  const plain = sentence.replace(PROGRAM_NAMES, " ").replace(ORDINARY_PHRASES, " ");
  if (IDENTITY_WITH_NAME.some((pattern) => pattern.test(plain))) return true;
  return OTHER_SELF.some((pattern) => pattern.test(sentence));
}

function sentenceNamesProvider(sentence: string, ids: RegExp | null): boolean {
  if (selfIdentifiesAsOther(sentence)) return true;
  if (ALWAYS_PATTERN.test(sentence) || MODEL_ID_PATTERN.test(sentence) || ids?.test(sentence)) return true;
  if (!WORD_PATTERN.test(sentence)) return false;
  return IDENTITY_STATEMENT.test(sentence) || WORD_PATTERN.test(sentence.replace(ORDINARY_PHRASES, " "));
}

const SENTENCE_BREAK = /((?<=[.!?…])\s+|\n+)/;

function sentences(text: string): string[] {
  return text.split(SENTENCE_BREAK).filter((_, i) => i % 2 === 0);
}

export function containsProviderName(text: string, modelIds: readonly string[] = []): boolean {
  const ids = idPattern(modelIds);
  return sentences(text).some((s) => sentenceNamesProvider(s, ids));
}

export interface GuardOptions {
  // The model IDs this deployment calls, so a reply naming one is caught.
  modelIds?: readonly string[];
}

// A sentence that names a provider and talks about the speaker is a
// self-description: "I'm Muse Spark!", "This is ChatGPT", "Mano runs on Llama".
const SELF_REFERENCE = /\b(?:i|i'm|i’m|im|me|my|myself|mano|this is|you(?:'re|’re| are) (?:talking|chatting|texting) (?:to|with))\b/i;

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
    .replace(/^[ \t]*\d{1,2}[.)][ \t]+(.+)$/gm, (_m, line: string) => endSentence(line))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
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

// Rewrites or drops every sentence that names a model or provider. The
// kept sentences keep their own breaks, and a dropped line break
// survives, so no two lines merge into a new sentence on the next pass.
function removeProviderNames(text: string, ids: RegExp | null): { text: string; selfDescribed: boolean } {
  let selfDescribed = false;
  let out = "";
  let gap = "";
  const parts = text.split(SENTENCE_BREAK);
  for (let i = 0; i < parts.length; i += 2) {
    gap += i > 0 ? parts[i - 1] : "";
    let sentence: string | null = parts[i];
    if (sentenceNamesProvider(sentence, ids)) {
      sentence = (SELF_REFERENCE.test(sentence) || selfIdentifiesAsOther(sentence)) && !selfDescribed ? SELF_DESCRIPTION : null;
      if (sentence) selfDescribed = true;
    }
    if (sentence === null) continue;
    if (out) out += gap.includes("\n") ? "\n" : " ";
    out += sentence;
    gap = "";
  }
  return { text: out, selfDescribed };
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function guardReply(raw: string, opts: GuardOptions = {}): GuardResult {
  const ids = idPattern(opts.modelIds ?? []);
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
  if (sentences(text).some((s) => sentenceNamesProvider(s, ids))) {
    const named = removeProviderNames(text, ids);
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
