// Content safety for mail reading. Letter text is evidence, never
// permission: instructions found inside a letter are reported as
// warnings, never followed. Links and phone numbers are never acted on
// here; they are returned as warnings for the action gateway, which
// checks them before use.

import type { Citation } from "./types.js";

export interface ContentFlag {
  kind: "instruction" | "link" | "phone" | "scam";
  // Short label for the warning message.
  label: string;
  // Exact substring that triggered the flag.
  match: string;
  detail?: string;
}

// Phrases that attempt to instruct the reader rather than inform the
// resident. Kept narrow: ordinary letter language ("you must respond
// by ...", "call us at ...") does not match.
const INSTRUCTION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /ignore\s+(all\s+|any\s+|all\s+of\s+your\s+|your\s+)?previous\s+instructions?/i, label: "tells the reader to ignore previous instructions" },
  { re: /ignore\s+(all\s+|any\s+)?(prior|above)\s+instructions?/i, label: "tells the reader to ignore prior instructions" },
  { re: /disregard\s+(all\s+|any\s+)?(previous|prior|above|your)\s+(instructions?|rules?|guidelines?)/i, label: "tells the reader to disregard instructions" },
  { re: /forget\s+(all\s+|everything\s+)?(you\s+were\s+told|your\s+instructions)/i, label: "tells the reader to forget its instructions" },
  { re: /you\s+are\s+now\s+(a|an)\s+[a-z ]{2,40}\s*(assistant|agent|representative|system)\b/i, label: "attempts to redefine the reader" },
  { re: /call\s+this\s+number\s+(now|immediately|right\s+away|urgently)/i, label: "presses for an immediate call" },
  { re: /do\s+not\s+(tell|inform|notify|show)\s+(the\s+)?(resident|user|person|recipient|client)\b/i, label: "tells the reader to hide something from the person" },
  { re: /keep\s+this\s+(letter|notice|message|information)\s+(secret|confidential)\s+from/i, label: "tells the reader to keep secrets from the person" },
  { re: /wire\s+(the\s+)?(money|payment|funds)\s+(now|immediately|today)/i, label: "presses for an immediate wire" },
  { re: /send\s+(payment|money|funds)\s+(via|through|to)\s+[a-z ]{1,30}(gift\s*card|bitcoin|crypto|wire)/i, label: "asks for payment by gift card, crypto or wire" },
  { re: /system\s+prompt|developer\s+message/i, label: "references a system prompt or developer message" },
];

const LINK_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const WWW_RE = /\bwww\.[a-z0-9-]+(\.[a-z0-9-]+)+[^\s<>"')\]]*/gi;
// A bare domain with no scheme or www ("benefits-unlock.help/login"),
// on any lowercase top-level domain of two or more letters, so "Case
// No." or "U.S." never match and neither does a missing space after a
// period ("form.Please"). Never the domain of an email address.
const BARE_DOMAIN_RE =
  /(?<![@\w.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[a-z]{2,24}(?![\w@-])(?:\/[^\s<>"')\]]*)?/g;
// NANP-ish numbers: (555) 123-4567, 555-123-4567, 555.123.4567,
// 5551234567 with separators, optional leading 1.
const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

const URGENCY_WORDS = [
  "urgent",
  "immediately",
  "right away",
  "final notice",
  "last chance",
  "act now",
  "expires today",
  "locked",
  "suspended",
];

export function findInstructions(text: string): ContentFlag[] {
  const flags: ContentFlag[] = [];
  for (const p of INSTRUCTION_PATTERNS) {
    const m = text.match(p.re);
    if (m) flags.push({ kind: "instruction", label: p.label, match: m[0] });
  }
  return flags;
}

export function findLinks(text: string): ContentFlag[] {
  const flags: ContentFlag[] = [];
  const seen = new Set<string>();
  const collect = (re: RegExp, source = text) => {
    for (const m of source.matchAll(re)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (!seen.has(url)) {
        seen.add(url);
        flags.push({ kind: "link", label: "link needs a safety check before use", match: url });
      }
    }
  };
  collect(LINK_RE);
  collect(WWW_RE);
  // Bare domains outside the links already found.
  collect(BARE_DOMAIN_RE, text.replace(LINK_RE, (m) => " ".repeat(m.length)).replace(WWW_RE, (m) => " ".repeat(m.length)));
  return flags;
}

export function findPhones(text: string): ContentFlag[] {
  const flags: ContentFlag[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    // Skip dates and short runs that are not dialable numbers.
    if (digits.length < 10 || digits.length > 11) continue;
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      flags.push({ kind: "phone", label: "phone number needs a check before use", match: m[0] });
    }
  }
  return flags;
}

function hostOf(url: string): string | null {
  try {
    const withScheme = url.includes("://") ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Payment by crypto, wire transfer or a payment app is a scam signal
// whenever the letter also mentions paying, in any sentence, so passive
// demands and demands split across sentences count. Gift and prepaid
// cards are different: benefits are paid onto EBT and prepaid cards,
// so a card counts only with a demand to buy, load or purchase one, to
// pay a fee or amount with it, or to hand over its numbers. Handing
// over codes or card numbers always counts. Only the clause where the
// sender says it never asks for, requires or accepts such a method, or
// tells the person never to give out codes or card numbers, is set
// aside; the rest of that sentence is still screened. EBT is never a
// signal.
const APP_METHOD = /\b(?:bitcoin|crypto(?:currency)?|wire\s+transfers?|zelle|cash\s*app|venmo)\b/i;
const PAYING = /\b(?:pay|pays|paid|paying|payment|payments|fee|fees|purchase|buy|send\s+them)\b|\$\s*\d/i;
const CARD = /\b(?:gift|prepaid)\s+(?:debit\s+)?cards?\b/i;
const BUY_CARD =
  /(?:^|[:;,]\s*|\b(?:and|then|please|now|must|need\s+to|have\s+to|required\s+to)\s+)(?:buy|purchase|load)\b(?:(?!\b(?:with|using|for|at)\b)[^.!?,;]){0,40}\b(?:gift|prepaid)\s+(?:debit\s+)?cards?\b/i;
const PAY_WITH_CARD =
  /\b(?:pay|payment)\b[^.!?]{0,60}\b(?:with|in|using|by|on)\s+(?:a\s+|an\s+|the\s+)?(?:(?:gift|prepaid)\s+(?:debit\s+)?cards?|it|them)\b|\bpayment\s+must\s+be\s+in\s+(?:gift|prepaid)/i;
const CODES_DEMAND =
  /\b(?:text|call|send|read|give|email)\b[^.!?]{0,60}\b(?:codes|card\s+numbers|(?:numbers?|pins?)\b[^.!?]{0,30}\b(?:gift|prepaid)\s+(?:debit\s+)?cards?)\b/i;
const METHOD =
  String.raw`(?:(?:gift|prepaid)\s+(?:debit\s+)?cards?|bitcoin|crypto(?:currency)?|wire\s+transfers?|zelle|cash\s*app|venmo|codes|card\s+numbers)`;
const NEVER_ASKS = new RegExp(
  String.raw`\b(?:never|not|won't|don't|doesn't)\s+(?:ever\s+)?(?:ask|request|require|accept|take|give|send|share)\b` +
    String.raw`(?:(?!\b(?:so|but|instead|then)\b)[^.!?,;:]){0,60}?\b${METHOD}(?:\s*,?\s*(?:(?:and|or)\s+)?${METHOD})*`,
  "gi",
);

function paymentDemand(text: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+|\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const counted = sentences.map((s) => s.replace(NEVER_ASKS, " "));
  const find = (test: (s: string) => boolean): string | null => {
    const k = counted.findIndex(test);
    return k < 0 ? null : sentences[k]!;
  };
  const codes = find((s) => CODES_DEMAND.test(s));
  if (codes) return codes;
  const app = find((s) => APP_METHOD.test(s));
  if (app && PAYING.test(text)) return app;
  if (counted.some((s) => CARD.test(s))) return find((s) => BUY_CARD.test(s) || PAY_WITH_CARD.test(s));
  return null;
}

// Heuristic scam screen over a whole letter, every page together.
// Returns flags; the pipeline turns them into scam_suspect warnings.
// Two signals: a payment demand by an untraceable method (above), or
// urgency language plus a payment or verification ask plus a link
// whose host is not a .gov host. A printed sender name never exempts a
// link: it is unverified evidence. A real agency letter with a plain
// phone number never matches.
export function screenScam(text: string): ContentFlag[] {
  const demand = paymentDemand(text);
  if (demand) {
    return [{ kind: "scam", label: "demands payment by gift or prepaid card, wire, crypto or a payment app", match: demand }];
  }
  const lower = text.toLowerCase();
  const urgency = URGENCY_WORDS.filter((w) => lower.includes(w));
  if (urgency.length === 0) return [];
  const asksPayment = /pay\b|payment|verify|confirm\s+your|update\s+your\s+(account|information|benefits)/i.test(text);
  if (!asksPayment) return [];
  // A real office never tells the person not to contact it.
  const cutOff = text.match(/\b(?:do\s+not|don't|never)\s+(?:call|contact|phone|visit)\s+(?:the\s+|your\s+)?(?:county|office|agency|state|caseworker|benefits\s+office)\b[^.!?\n]*/i);
  if (cutOff) {
    return [{ kind: "scam", label: "urgent verification ask that tells the person not to contact their office", match: cutOff[0], detail: `urgency words: ${urgency.slice(0, 3).join(", ")}` }];
  }
  const suspicious = findLinks(text).filter((l) => {
    const host = hostOf(l.match);
    return !host || !host.endsWith(".gov");
  });
  if (suspicious.length === 0) return [];
  return [
    {
      kind: "scam",
      label: "urgent payment or verification ask with an unofficial link",
      match: suspicious[0]!.match,
      detail: `urgency words: ${urgency.slice(0, 3).join(", ")}`,
    },
  ];
}

// Instructions, links and phones in one piece of text. Scams are
// screened on the whole letter instead (screenScam).
export function scanContent(text: string): ContentFlag[] {
  return [...findInstructions(text), ...findLinks(text), ...findPhones(text)];
}

// Attach a page-level citation when the flag has no field-level box.
export function citePage(file: string, page: number): Citation {
  return { file, page, box: { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 } };
}
