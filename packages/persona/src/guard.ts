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

// What counts as naming the model or its maker, in three tiers:
// A. Our own stack (muse, glimmer, llama, "muse spark", any model ID,
//    and the configured IDs) counts anywhere, in any case.
// B. "meta" and "spark" count after a maker or power verb anywhere in
//    the sentence ("I'm Mano, powered by Meta").
// C. Every other company or product counts only when the assistant
//    identifies itself: "I'm X", "my name is X", "I was made by X",
//    "X made me", "this is X, your assistant". Anywhere else it is
//    benefits help: "Walmart and Amazon accept SNAP online", "This is
//    the Amazon Fresh page".
// Names not on any list count only in "my name is X", a capitalized
// "I'm X", or the assistant itself made or built by X.

const STACK_WORDS = ["muse", "glimmer", "llama"];
const STACK_PATTERN = new RegExp(`\\b(?:muse spark|${STACK_WORDS.join("|")})\\b`, "i");
const MODEL_ID_PATTERN = /\b(?:muse|spark|glimmer|llama|gpt|claude|gemini|mistral|grok)[-_. ]?(?:[a-z]+[-_. ]?)?\d[\w.-]*/i;
// The only uses of a stack word Mano may send, unless the sentence also
// makes an identity statement. Each is covered by a test.
const ORDINARY_PHRASES = /\b(?:spark of hope|glimmer of hope|muse (?:on|about))\b/gi;
const IDENTITY_STATEMENT =
  /\b(?:i am|i'm|i’m|im|my name is|this is|powered by|built (?:on|by)|made by|trained by|runs? on|running on|based on|models?|assistant from)\b/i;

const MAKER_CLAUSE_STACK =
  /\b(?:powered|built|made|created|developed|trained|designed|running|runs?|based)\b[^.!?\n]*?\b(?:by|on|with|from)\s+(?:the\s+)?(?:muse\s+)?(?:meta|spark)\b/i;

const OTHER_NAMES = [
  "meta", "spark", "openai", "chatgpt", "gpt", "google", "gemini", "bard", "anthropic", "claude", "microsoft", "copilot",
  "bing", "amazon", "alexa", "nova", "apple", "siri", "mistral", "deepseek", "grok", "xai",
  "muse", "glimmer", "llama", "large language model", "language model", "llm", "ai model",
];
const NAME = `(?:${OTHER_NAMES.join("|")})`;
const ASSISTANT_WORD = "(?:ai|virtual|voice|digital|assistant|model|bot|chatbot|version|helper)";
const ASSISTANT_NOUN = "(?:assistant|model|bot|chatbot|helper)";
const FILLER = `(?:(?:a|an|the|your|just|actually) )?(?:${ASSISTANT_WORD} )*`;
const I_AM = "(?:i am|i'm|i’m|im)";
const SELF = "(?:i|i was|i am|i'm|i’m|im|mano|mano is|mano was)";
const MAKER = "(?:made|built|created|developed|trained|powered|designed|programmed|engineered)";
const IDENTITY_WITH_NAME = [
  // "I'm Claude", "my name is the Spark". A bare "a" or "an" counts
  // only with an assistant word after the name, so "I'm a Gemini" passes.
  `\\b(?:${I_AM}|my name is) (?:(?:the|your|just|actually) )?(?:${ASSISTANT_WORD} )*${NAME}\\b`,
  `\\b${I_AM} (?:a|an) (?:large )?(?:language model|llm|ai model)\\b`,
  `\\b${I_AM} (?:a|an) (?:${ASSISTANT_WORD} )*${NAME}(?:['’]s)? (?:ai |virtual )?${ASSISTANT_NOUN}\\b`,
  `\\b(?:${I_AM}|my name is)(?: (?:a|an|the|your))? ${NAME}['’]s (?:ai |virtual )?${ASSISTANT_NOUN}\\b`,
  `\\b${I_AM} (?:a|an|the|your) (?:[\\w-]+ )?${ASSISTANT_NOUN} (?:from|by|made by|built by|of) ${FILLER}${NAME}\\b`,
  `\\b${SELF}(?: (?:an?|the) (?:[\\w-]+ )?(?:assistant|ai|model|bot|chatbot))? ${MAKER} (?:by|on|at) ${FILLER}${NAME}\\b`,
  `^\\s*(?:powered|built|made|created|developed|trained) (?:by|on) ${FILLER}${NAME}\\b`,
  `\\b(?:i run|i am based|i'm based|i’m based|im based|mano runs|mano is based|mano was built) on ${FILLER}${NAME}\\b`,
  `\\b(?:i|mano) (?:use|uses) ${NAME} (?:to|for) (?:answer|answers|reply|replies|respond|think|talk|write)\\b`,
  `\\b${NAME} (?:made|built|created|developed|trained|powers|runs|designed) (?:me|mano)\\b`,
  `\\bmy (?:maker|creator|developer|provider|company|model) is ${FILLER}${NAME}\\b`,
  // "This is" only as an assistant introducing itself: "this is X, your
  // assistant", "this is X Assistant", "this is X, made by Y".
  `\\bthis is (?:the )?${NAME}\\b[^.!?\\n]*?,? (?:your|an?) (?:[\\w-]+ )?${ASSISTANT_NOUN}\\b`,
  `\\bthis is (?:the )?${NAME} assistant\\b`,
  `\\bthis is (?:the )?${NAME},? ${MAKER} (?:by|on) \\S`,
].map((source) => new RegExp(source, "i"));
const PROGRAM_NAMES = /\bapple health\b/gi;

const OTHER_SELF = [
  /\bi(?: was| am|'m|’m)(?: (?:an?|the) (?:[\w-]+ )?(?:assistant|ai|model|bot|chatbot))? (?:developed|built|made|created|trained|designed|programmed|powered|engineered) (?:by|at|on)\s+(?!mano\b)\S/i,
  /\bmy name is\s+(?!mano\b)\S/i,
  // Case-sensitive on purpose: the name after it is capitalized. An
  // article counts only before an assistant word, so "I'm a Medicaid
  // expert" passes.
  /\b[Ii](?:'m|’m| am) (?:(?:an?|the) (?:(?:[Aa][Ii]|AI|assistant|model|bot|chatbot|version|virtual) )+|(?:(?:[Aa][Ii]|AI|assistant|model|bot|chatbot|version) )*)(?:called |named )?(?!Mano\b)[A-Z]/,
];

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

function selfIdentifiesAsOther(sentence: string): boolean {
  const plain = sentence.replace(PROGRAM_NAMES, " ").replace(ORDINARY_PHRASES, " ");
  if (IDENTITY_WITH_NAME.some((pattern) => pattern.test(plain)) || MAKER_CLAUSE_STACK.test(plain)) return true;
  return OTHER_SELF.some((pattern) => pattern.test(sentence));
}

function sentenceNamesProvider(sentence: string, ids: RegExp | null): boolean {
  if (selfIdentifiesAsOther(sentence)) return true;
  if (MODEL_ID_PATTERN.test(sentence) || ids?.test(sentence)) return true;
  if (!STACK_PATTERN.test(sentence)) return false;
  return IDENTITY_STATEMENT.test(sentence) || STACK_PATTERN.test(sentence.replace(ORDINARY_PHRASES, " "));
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
