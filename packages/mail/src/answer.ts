// What Mano tells the person about the mail it just read. The reply is
// built from closed fields only, in Mano's own words: the program (a name
// from Mano's list, else "benefits"), the letter type, the deadline date
// the gate published, and what to send as categories. No free text from
// the letter ever reaches the reply, so no phone number, link, address or
// instruction can, however the letter writes it. A deadline the gate did
// not publish becomes one question that names a date only when the letter
// gives exactly one with no doubt around it. A scam letter gets a plain
// warning, and a letter whose only trouble is a link a warning about the
// link. Either way its date is said only as what the letter claims, to check
// with the office, so a false alarm never takes a real date away and a real
// scam's date is never stated as fact. Mano holds no deadline from either.
import type { Letter, LetterFields, MailReading, Obligation, Question, Warning } from "./types.js";
import { ANSWER_WORDS, type AnswerWords, type ReplyLanguage } from "./words.js";

// What a held deadline is for, when the published sentence says.
export type DeadlineKind = "renewal" | "recertification" | "redetermination" | "interview" | "hearing" | "appeal" | "payment" | "documents";

export type LetterType =
  | "renewal"
  | "interview"
  | "documents needed"
  | "change notice"
  | "denial"
  | "overpayment"
  | "hearing"
  | "other";

export type SendCategory =
  | "proof of income"
  | "ID"
  | "proof of address"
  | "pay stubs"
  | "bank statements"
  | "rent or utility bills"
  | "household member info"
  | "other documents the letter lists";

// A deadline the gate published: Mano holds it without asking.
export interface HeldDeadline {
  letterId: string;
  // The InputFile name its sentence is cited on.
  file: string;
  // Short and plain ("Medi-Cal renewal"), from closed fields.
  title: string;
  kind: DeadlineKind | null;
  dueDate: string;
  // The program by Mano's name for it, and its federal name.
  program: string | null;
  federalProgram: string | null;
  // The sentence the gate published, for the deadline record. It passed
  // the gate's grammar; the reply never quotes it.
  sentence: string;
}

export interface MailAnswer {
  // "unread" when no letter could be read from the files.
  outcome: "read" | "unread";
  text: string;
  deadlines: HeldDeadline[];
}

function listOf(items: string[], and: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

// Programs Mano names: how it says the name, and the federal program.
const PROGRAMS: { match: RegExp; name: string; federal: string }[] = [
  { match: /\bcalfresh\b/i, name: "CalFresh", federal: "SNAP" },
  { match: /\b(snap|food stamps|basic food|food assistance)\b/i, name: "SNAP", federal: "SNAP" },
  { match: /\bmedi-?cal\b/i, name: "Medi-Cal", federal: "Medicaid" },
  { match: /\b(medicaid|masshealth|apple health|tenncare|soonercare|badgercare)\b/i, name: "Medicaid", federal: "Medicaid" },
  { match: /\bcalworks\b/i, name: "CalWORKs", federal: "TANF" },
  { match: /\b(tanf|cash assistance)\b/i, name: "TANF", federal: "TANF" },
  { match: /\bwic\b/i, name: "WIC", federal: "WIC" },
  { match: /\b(ssi|supplemental security income)\b/i, name: "SSI", federal: "SSI" },
  { match: /\bliheap\b/i, name: "LIHEAP", federal: "LIHEAP" },
  { match: /\b(housing choice voucher|section 8)\b/i, name: "Housing Choice Voucher", federal: "Housing Choice Voucher" },
];

function programOf(fields: LetterFields): { name: string; federal: string } | null {
  const named = [fields.program?.value, fields.subject?.value, fields.sender?.value].filter((v): v is string => Boolean(v));
  for (const value of named) {
    const hit = PROGRAMS.find((p) => p.match.test(value));
    if (hit) return { name: hit.name, federal: hit.federal };
  }
  return null;
}

function letterText(letter: Letter): string {
  const f = letter.fields;
  return [f.subject?.value, f.program?.value, f.deadlineText?.value, f.consequence?.value, f.excerpt, ...f.asked.map((a) => a.value)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

// First match wins: the narrowest types come first.
const TYPES: [RegExp, LetterType][] = [
  [/\bhearing\b|\bappeal/, "hearing"],
  [/overpa(id|yment)/, "overpayment"],
  [/\bden(ied|ial)\b|not eligible|ineligible/, "denial"],
  [/\binterview\b/, "interview"],
  // A next renewal is a date the letter states, not what it is about:
  // "Next renewal November 22, 2026" on an approval is not a renewal letter.
  [/(?<!\bnext[ \t]+)(?:\brenew|recertif|redetermin)/, "renewal"],
  [/\bmissing\b|\bverif(y|ication)\b|need(ed)? (more )?(information|documents|proof)|documents? needed|send (us )?(proof|copies)/, "documents needed"],
  [/\bchang(e|ed|es)\b|\breduc|\bincreas|new amount|will (stop|end)/, "change notice"],
];

function typeOf(letter: Letter): LetterType {
  const text = letterText(letter);
  return TYPES.find(([re]) => re.test(text))?.[1] ?? "other";
}

// How each category is recognized; pay stubs before income, so a stub
// counts as both.
const CATEGORIES: [RegExp, SendCategory][] = [
  [/\bpay ?stubs?\b|\bpaychecks?\b|\bcheck stubs?\b/, "pay stubs"],
  [/\bincome\b|\bearnings\b|\bwages\b|\baward letters?\b/, "proof of income"],
  [/\bphoto id\b|\bid\b|identification|driver'?s licen[cs]e|\bpassport\b/, "ID"],
  [/\baddress\b|\blease\b|\bresiden/, "proof of address"],
  [/\bbank\b/, "bank statements"],
  [/\brent\b|\butilit|\belectric|\bgas bill|\bwater bill/, "rent or utility bills"],
  [/household members?|who lives with you|birth certificates?|social security (cards?|numbers?)/, "household member info"],
];
const OTHER: SendCategory = "other documents the letter lists";
// The order Mano lists them in.
const ORDER: SendCategory[] = [
  "proof of income", "ID", "proof of address", "pay stubs", "bank statements", "rent or utility bills", "household member info", OTHER,
];

function categoriesOf(letter: Letter): SendCategory[] {
  const found = new Set<SendCategory>();
  for (const item of letter.fields.asked) {
    const text = item.value.toLowerCase();
    const hits = CATEGORIES.filter(([re]) => re.test(text)).map(([, c]) => c);
    if (hits.length === 0) found.add(OTHER);
    for (const c of hits) found.add(c);
  }
  return ORDER.filter((c) => found.has(c));
}

// The kind follows the duty the gate read, so a word that only
// qualifies it ("your recertification appeal") never names it. Within a
// renewal, the last renewal word is the head noun. Only what the
// published sentence says; no kind when it says none.
function kindOf(sentence: string, obligation: Obligation): DeadlineKind | null {
  const t = sentence.toLowerCase();
  if (obligation === "appeal") return /\bhearing\b/.test(t) ? "hearing" : "appeal";
  if (obligation === "pay") return "payment";
  if (obligation === "renew") {
    const head = t.match(/\b(?:renew|recertif|redetermin)/g)?.at(-1);
    return head === "recertif" ? "recertification" : head === "redetermin" ? "redetermination" : "renewal";
  }
  if (/\brecertif/.test(t)) return "recertification";
  if (/\binterview\b/.test(t)) return "interview";
  if (/\bhearing\b/.test(t)) return "hearing";
  if (/\bappeal\b/.test(t)) return "appeal";
  if (obligation === "respond" && /\b(proofs?|documents?|forms?|pay stubs?|paperwork|records?|statements?|receipts?)\b/.test(t)) return "documents";
  return null;
}

const DOUBT = /\b(not|never|don'?t|do not|no longer|unless|if|except|instead|actual|either|or)\b/i;

// The one date a deadline question can name: only when the letter gives
// exactly one and nothing around it casts doubt. "unclear" names none, so
// Mano never picks among candidates.
function soleDate(question: Question): string | "unclear" | null {
  const proposal = question.proposal;
  const withheld = [...(proposal?.others ?? []), ...(question.candidates ?? [])];
  const sentences = [...(proposal ? [proposal.sentence] : []), ...withheld.map((c) => c.sentence)];
  const dates = new Set([...(proposal ? [proposal.dueDate] : []), ...withheld.flatMap((c) => c.dates)]);
  if (dates.size === 0) return null;
  const doubted = sentences.some((s) => DOUBT.test(s)) || Boolean(proposal?.count);
  return dates.size === 1 && !doubted ? [...dates][0]! : "unclear";
}

function heldBackQuestion(question: Question, w: AnswerWords): string | null {
  const date = soleDate(question);
  if (!date) return null;
  if (date === "unclear") return w.severalDates;
  return w.askDate(w.date(date));
}

// The date stays the letter's claim: it is said, never held, since the
// person may be reading a real deadline or a scam's.
function suspectLinkLines(question: Question | undefined, w: AnswerWords): string[] {
  const date = question ? soleDate(question) : null;
  if (!date) return [w.suspectLink, w.notSure];
  const claim = date === "unclear" ? w.mentionsADate : w.claim(w.date(date));
  return [w.suspectLink, claim, w.checkWithOffice, w.confirmedThenTell];
}

// The dates are the letter's words, kept only so a false alarm can say them.
function scamLines(warning: Warning, w: AnswerWords): string[] {
  const date = warning.claimedDate;
  if (!date) return [w.scam];
  return [w.scam, date === "several" ? w.mentionsSeveral : w.claim(w.date(date)), w.checkWithOffice];
}

// A letter in a pile that can wait: plain type, nothing asked, no date, no
// stated consequence. Telling someone so is a claim, so any doubt says nothing.
function canWait(letter: Letter, type: LetterType, send: SendCategory[], question: Question | undefined): boolean {
  return type === "other" && send.length === 0 && !letter.fields.consequence && !letter.fields.deadlineText && !question?.proposal && !question?.candidates?.length;
}

function letterAnswer(reading: MailReading, letter: Letter, w: AnswerWords, inPile: boolean): { lines: string[]; held: HeldDeadline | null } {
  const warnings = reading.warnings.filter((w) => w.letterId === letter.id);
  const scam = warnings.find((w) => w.kind === "scam_suspect");
  if (scam) return { lines: scamLines(scam, w), held: null };
  const question = reading.questions.find((q) => q.letterId === letter.id && q.kind === "confirm_deadline");
  if (warnings.some((w) => w.kind === "link_suspect")) {
    const planted = warnings.some((w) => w.kind === "instruction_in_content");
    return { lines: [...suspectLinkLines(question, w), ...(planted ? [w.planted] : [])], held: null };
  }
  const program = programOf(letter.fields);
  const type = typeOf(letter);
  const lines = [w.letterType[type](program?.name ?? w.benefits)];
  const proposal = question?.proposal;
  let held: HeldDeadline | null = null;
  let ask: string | null = null;
  if (proposal?.confidence === "high") {
    const kind = kindOf(proposal.sentence, proposal.obligation);
    held = {
      letterId: letter.id,
      file: proposal.citation.file,
      title: [program?.name, kind].filter(Boolean).join(" ") || "Letter deadline",
      kind,
      dueDate: proposal.dueDate,
      program: program?.name ?? null,
      federalProgram: program?.federal ?? null,
      sentence: proposal.quote,
    };
    // A published "next renewal" is the renewal the person owes next.
    const next = /\bnext\s+(?:renewal|recertification)\b/i.test(proposal.sentence) && (kind === "renewal" || kind === "recertification");
    lines.push(next ? w.nextDue(kind, w.date(proposal.dueDate)) : w.due(w.date(proposal.dueDate)));
  } else if (question) {
    ask = heldBackQuestion(question, w);
  }
  const send = categoriesOf(letter);
  if (send.length > 0) lines.push(w.asksToSend(listOf(send.map((c) => w.categories[c]), w.and)));
  if (inPile && canWait(letter, type, send, question)) lines.push(w.canWait);
  if (warnings.some((warning) => warning.kind === "instruction_in_content")) lines.push(w.planted);
  lines.push(w.official);
  // The question goes last, so the reply ends on the one thing to answer.
  if (ask) lines.push(ask);
  return { lines, held };
}

// A letter with nothing read from it: every page failed or was unreadable.
function wasRead(letter: Letter): boolean {
  const f = letter.fields;
  return f.excerpt.trim().length > 0 || f.asked.length > 0 || [f.sender, f.program, f.subject, f.deadlineText].some(Boolean);
}

export function answerReading(reading: MailReading, language: ReplyLanguage = "en"): MailAnswer {
  const w = ANSWER_WORDS[language];
  const read = reading.letters.filter(wasRead);
  const failed = reading.questions.some((q) => q.kind === "read_failed" || q.kind === "budget_exceeded");
  if (read.length === 0) return { outcome: "unread", text: failed ? w.failed : w.unread, deadlines: [] };
  const answers = read.map((letter) => letterAnswer(reading, letter, w, read.length > 1));
  const paragraphs = answers.map((a, i) => (answers.length > 1 ? `${w.letterNumber(i + 1)} ${a.lines.join(" ")}` : a.lines.join(" ")));
  const missed = read.length < reading.letters.length || reading.questions.some((q) => q.letterId === null && q.kind !== "video_truncated");
  if (missed) paragraphs.push(w.missedPart);
  return {
    outcome: "read",
    text: paragraphs.join("\n\n"),
    deadlines: answers.flatMap((a) => (a.held ? [a.held] : [])),
  };
}
