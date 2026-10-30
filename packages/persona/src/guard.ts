// Deterministic voice guard. Runs on every outgoing text before it is
// sent. It always returns sendable text: dashes and markdown are
// rewritten in place, a self-description that names a model or
// provider becomes SELF_DESCRIPTION, any other sentence that names one
// is dropped, and a reply with nothing left becomes SAFE_REPLY.
// Callers log the change names, never the text. guardReply is
// idempotent, so a replayed send carries the same bytes.

import { SAFETY_LINE } from "./crisis.js";

// A Unicode-aware \b. JavaScript's \b only knows ASCII letters, so it sees
// no word end after an accented letter ("Llama me creó."). Every guard
// pattern is built through uw(), which swaps \b for this edge and adds the
// u flag.
const WORD_EDGE = String.raw`(?:(?<=[\p{L}\p{N}])(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?=[\p{L}\p{N}]))`;

function uw(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("u") ? pattern.flags : `${pattern.flags}u`;
  return new RegExp(pattern.source.replaceAll(String.raw`\b`, WORD_EDGE), flags);
}

export const SELF_DESCRIPTION = "I'm Mano, an automated assistant.";

// Sent when a reply has nothing sendable left, and when the model fails.
// Like every reply sent without the model, it carries SAFETY_LINE.
export const SAFE_REPLY = `Sorry, I hit a snag on my end and lost that one. Can you send it again in a minute? ${SAFETY_LINE}`;

export type GuardChange = "route-marker" | "speaker-label" | "markdown" | "dash" | "self-description" | "provider-name" | "empty";

export interface GuardResult {
  text: string;
  changes: GuardChange[];
}

// What counts as naming the model or its maker, in two tiers:
// A. Our own stack (meta, spark, muse, glimmer, llama, any model ID and
//    the configured IDs) counts anywhere, in any case, except four
//    idioms: "spark of hope", "glimmer of hope", "muse on", "muse about".
// B. Every other company or product counts only in a direct first-person
//    "I'm X" or "my name is X" outside quotation marks, or a maker or
//    power clause about the assistant ("I was made by X", "X made me").
//    Anywhere else it is benefits help: "Walmart and Amazon accept SNAP
//    online", "your caseworker Claude".
// Names on no list count only in "my name is X", a capitalized "I'm X",
// or the assistant itself made or built by X, outside quotation marks.

const STACK_PATTERN = uw(/\b(?:meta|spark|muse|glimmer)\b/i);
// A family name, at most one more model word, then a version: "muse spark
// 1.3", "gpt-4o". Llama has its own rule below.
const MODEL_ID_PATTERN =
  uw(/\b(?:muse|spark|glimmer|gpt|claude|gemini|mistral|grok)(?:[-_. ]?(?:spark|glimmer|instruct|chat|pro|mini|nano|turbo|flash|sonnet|opus|haiku))?[-_. ]?\d[\w.-]*/i);
const ORDINARY_PHRASES = uw(/\b(?:spark of hope|glimmer of hope|muse (?:on|about))\b/gi);

// "llama" is also Spanish for "call" ("se llama DSHS", "llama al 911"), so
// it is the one stack word that does not count anywhere. It counts only
// in a model position: before a model version, near a model word, inside
// an identity construction, or capitalized in the middle of a sentence
// and not before al, a, ahora, ya or hoy.
// A model version is one digit, optionally .digits, optionally B, -instruct
// or -chat (Llama 3, Llama 3.1, llama-3.1-8b, Llama3). Never a time or
// duration ("Llama 24 horas antes", "Llama 3 hours before") or a phone
// number ("Llama 1-800-555-0100").
const LLAMA_UNITS = "(?:horas?|hours?|d[ií]as?|days?|minutos?|minutes?|semanas?|weeks?)";
const LLAMA_MODEL = [
  uw(new RegExp(
    String.raw`\bllama[-_ ]?\d(?:\.\d+)*(?:[-_ ]?\d*b|-instruct|-chat)*(?![\w-]|\.\d)(?! ?${LLAMA_UNITS}\b)`,
    "iu",
  )),
  uw(/\bllama (?:powers|runs|made|built|trained|created|answers for) (?:me|mano)\b/i),
  uw(/\b(?:my|mi) (?:provider|model|maker|creator|proveedor|modelo|creador) (?:is|es) (?:the |el )?llama\b/i),
  uw(/\bllama (?:me impulsa|me hizo|me cre[óo]|me entren[óo])\b/iu),
  uw(/\bllama\b.*\b(?:models?|modelos?|llms?|open[- ]source|c[óo]digo abierto|open[- ]weights?|weights|pesos abiertos)\b|\b(?:models?|modelos?|llms?|open[- ]source|c[óo]digo abierto|open[- ]weights?|weights)\b.*\bllama\b/i),
  uw(/\b(?:uso|usamos|i use|we use|basad[oa] en|based on|powered by|funciona con|funciono con|runs? on|running on|built on|made by|hecho por|impulsado por|soy|i am|i'm|i’m)\b(?: [\p{L}'’-]+){0,3} llama\b/iu),
  uw(/(?<=[\p{L}\d,] )Llama\b(?! (?:al?|ahora|ya|hoy)\b)/u),
];

function namesLlama(sentence: string): boolean {
  return LLAMA_MODEL.some((pattern) => pattern.test(sentence));
}
// An identity statement beats the idioms: "I'm powered by the spark of hope" still leaks.
const IDENTITY_STATEMENT =
  uw(/\b(?:i am|i'm|i’m|im|my name is|this is|powered by|built (?:on|by)|made by|trained by|runs? on|running on|based on|models?|assistant from)\b/i);
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;

const OTHER_NAMES = [
  "openai", "chatgpt", "gpt", "google", "gemini", "bard", "anthropic", "claude", "microsoft", "copilot", "bing", "amazon",
  "alexa", "nova", "apple", "siri", "mistral", "deepseek", "grok", "xai", "large language model", "language model", "llm", "ai model",
];
const NAME = `(?:${OTHER_NAMES.join("|")})`;
const ASSISTANT_WORD = "(?:ai|virtual|voice|digital|assistant|model|bot|chatbot|version|helper)";
const ASSISTANT_NOUN = "(?:assistant|model|bot|chatbot|helper)";
const FILLER = `(?:(?:a|an|the|your|just|actually) )?(?:${ASSISTANT_WORD} )*`;
const I_AM = "(?:i am|i'm|i’m|im)";
const SELF = "(?:i|i was|i am|i'm|i’m|im|mano|mano is|mano was)";
const MAKER = "(?:made|built|created|developed|trained|powered|designed|programmed|engineered)";
const OTHER_IDENTITY = [
  // Direct first person. A bare "a" or "an" counts only with an
  // assistant word after the name, so "I'm a Gemini" passes.
  `\\b(?:${I_AM}|my name is) (?:(?:the|your|just|actually) )?(?:${ASSISTANT_WORD} )*${NAME}\\b`,
  `\\b${I_AM} (?:a|an) (?:large )?(?:language model|llm|ai model)\\b`,
  `\\b${I_AM} (?:a|an) (?:${ASSISTANT_WORD} )*${NAME} (?:ai |virtual )?${ASSISTANT_NOUN}\\b`,
  // Maker and power clauses about the assistant.
  `\\b${SELF}(?: (?:an?|the) (?:[\\w-]+ )?(?:assistant|ai|model|bot|chatbot))? ${MAKER} (?:by|on|at) ${FILLER}${NAME}\\b`,
  `^\\s*(?:powered|built|made|created|developed|trained) (?:by|on) ${FILLER}${NAME}\\b`,
  `\\b(?:i run|i am based|i'm based|i’m based|im based|mano runs|mano is based|mano was built) on ${FILLER}${NAME}\\b`,
  `\\b(?:i|mano) (?:use|uses) ${NAME} (?:to|for) (?:answer|answers|reply|replies|respond|think|talk|write)\\b`,
  `\\b${NAME} (?:made|built|created|developed|trained|powers|runs|designed) (?:me|mano)\\b`,
  `\\bmy (?:maker|creator|developer|provider|company|model) is ${FILLER}${NAME}\\b`,
].map((source) => uw(new RegExp(source, "i")));
const PROGRAM_NAMES = uw(/\bapple health\b/gi);

const UNLISTED_SELF = [
  uw(/\bi(?: was| am|'m|’m)(?: (?:an?|the) (?:[\w-]+ )?(?:assistant|ai|model|bot|chatbot))? (?:developed|built|made|created|trained|designed|programmed|powered|engineered) (?:by|at|on)\s+(?!mano\b)\S/i),
  uw(/\bmy name is\s+(?!mano\b)\S/i),
  // Case-sensitive on purpose: the name after it is capitalized. An
  // article counts only before an assistant word, so "I'm a Medicaid
  // expert" passes.
  uw(/\b[Ii](?:'m|’m| am) (?:(?:an?|the) (?:(?:[Aa][Ii]|AI|assistant|model|bot|chatbot|version|virtual) )+|(?:(?:[Aa][Ii]|AI|assistant|model|bot|chatbot|version) )*)(?:called |named )?(?!Mano\b)[A-Z]/),
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
  const unquoted = sentence.replace(QUOTED, " ").replace(PROGRAM_NAMES, " ");
  return OTHER_IDENTITY.some((pattern) => pattern.test(unquoted)) || UNLISTED_SELF.some((pattern) => pattern.test(unquoted));
}

// Underscores, zero-width characters and similar join words for a
// regex but not for a reader: "Meta_AI" and "_muse_spark_1.3_" name the
// stack. Matching runs on a copy with them turned into spaces.
function separated(text: string): string {
  return text.replace(/[​-‍⁠﻿]/g, "").replace(/_+/g, " ");
}

// Quoted text is what the person should write or what a document says,
// never Mano describing itself. Each quoted span, single, double or
// curly, even across sentences, is swapped for a token before the text
// is split into sentences and restored afterwards. An apostrophe inside
// a word ("I'm") is not a quote mark.
// One pass over all four quote styles, leftmost first: the outermost
// quote becomes one token, so tokens never nest.
const QUOTE_SPANS = new RegExp(
  [
    /"[^"\n]*"/.source,
    /“[^”\n]*”/.source,
    /(?<![\w'’])'(?=\S)(?:[^'\n]|'(?=\w))*?(?<=\S)'(?!\w)/.source,
    /‘(?:[^’\n]|’(?=\w))*?’(?!\w)/.source,
  ].join("|"),
  "g",
);
const QUOTE_TOKEN = /⁣(\d+)⁣/g;

function protectQuotes(text: string): { text: string; quotes: string[] } {
  const quotes: string[] = [];
  const out = text.replace(QUOTE_SPANS, (span) => `\u2063${quotes.push(span) - 1}\u2063`);
  return { text: out, quotes };
}

function restoreQuotes(text: string, quotes: readonly string[]): string {
  return text.replace(QUOTE_TOKEN, (_m, i: string) => quotes[Number(i)] ?? "");
}

function namesOurStack(sentence: string, ids: RegExp | null): boolean {
  sentence = separated(sentence);
  if (MODEL_ID_PATTERN.test(sentence) || namesLlama(sentence) || ids?.test(sentence)) return true;
  if (!STACK_PATTERN.test(sentence)) return false;
  return IDENTITY_STATEMENT.test(sentence) || STACK_PATTERN.test(sentence.replace(ORDINARY_PHRASES, " "));
}

// The sentence arrives with its quotes as tokens. Our stack counts even
// inside quotes; every other name counts only outside them.
function sentenceNamesProvider(sentence: string, ids: RegExp | null, quotes: readonly string[]): boolean {
  return namesOurStack(restoreQuotes(sentence, quotes), ids) || selfIdentifiesAsOther(separated(sentence));
}

const SENTENCE_BREAK = /((?<=[.!?…])\s+|\n+)/;

function sentences(text: string): string[] {
  return text.split(SENTENCE_BREAK).filter((_, i) => i % 2 === 0);
}

export function containsProviderName(text: string, modelIds: readonly string[] = []): boolean {
  const ids = idPattern(modelIds);
  const guarded = protectQuotes(text);
  return sentences(guarded.text).some((s) => sentenceNamesProvider(s, ids, guarded.quotes));
}

export interface GuardOptions {
  // The model IDs this deployment calls, so a reply naming one is caught.
  modelIds?: readonly string[];
}

// A sentence that names a provider and talks about the speaker is a
// self-description: "I'm Muse Spark!", "This is ChatGPT", "Mano runs on Llama".
const SELF_REFERENCE = uw(/\b(?:i|i'm|i’m|im|me|my|myself|mano|this is|you(?:'re|’re| are) (?:talking|chatting|texting) (?:to|with))\b/i);

const DASHES = "‒–—―";

const LIST_MARK = /^[ \t]*(?:[-*+•◦▪‣○●]|\d{1,2}[.)])[ \t]+/;
const LIST_BLOCK = /(?:^[ \t]*(?:[-*+•◦▪‣○●]|\d{1,2}[.)])[ \t]+.+(?:\n|$)){2,}/gm;

export function stripMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*```.*$/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => (url.includes(label) ? url : `${label} (${url})`))
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_m, line: string) => endSentence(line))
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    // A checklist stays in one bubble: two or more list lines join into one.
    .replace(LIST_BLOCK, (block) => `${block.trim().split("\n").map((line) => endSentence(line.replace(LIST_MARK, "").trim())).join(" ")}\n`)
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
function removeProviderNames(text: string, ids: RegExp | null, quotes: readonly string[]): { text: string; selfDescribed: boolean } {
  let selfDescribed = false;
  let out = "";
  let gap = "";
  const parts = text.split(SENTENCE_BREAK);
  for (let i = 0; i < parts.length; i += 2) {
    gap += i > 0 ? parts[i - 1] : "";
    let sentence: string | null = parts[i];
    if (sentenceNamesProvider(sentence, ids, quotes)) {
      const plain = separated(sentence);
      const describesSelf = SELF_REFERENCE.test(plain) || IDENTITY_STATEMENT.test(plain) || selfIdentifiesAsOther(plain);
      sentence = describesSelf && !selfDescribed ? SELF_DESCRIPTION : null;
      if (sentence) selfDescribed = true;
    }
    if (sentence === null) continue;
    if (out) out += gap.includes("\n") ? "\n" : " ";
    out += sentence;
    gap = "";
  }
  return { text: restoreQuotes(out, quotes), selfDescribed };
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
  const unrouted = text.replace(/(^|[^A-Za-z])REACT:[ \t]*[a-z]*/gi, "$1 ").replace(/(^|[^A-Za-z])DEEP:[ \t]*/g, "$1 ");
  if (unrouted !== text) changes.push("route-marker");
  text = unrouted;
  // The soul's examples are written as "Mano: ..." lines, and a reply
  // sometimes copies the label onto a bubble.
  const unlabeled = text.replace(/^[ \t]*Mano:[ \t]*/gm, "");
  if (unlabeled !== text) changes.push("speaker-label");
  text = unlabeled;
  const unmarked = stripMarkdown(text);
  if (unmarked !== text) changes.push("markdown");
  text = unmarked;
  const undashed = removeDashes(text);
  if (undashed !== text) changes.push("dash");
  text = undashed;
  const guarded = protectQuotes(text);
  if (sentences(guarded.text).some((s) => sentenceNamesProvider(s, ids, guarded.quotes))) {
    const named = removeProviderNames(guarded.text, ids, guarded.quotes);
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
