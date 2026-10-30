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
  const collect = (re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (!seen.has(url)) {
        seen.add(url);
        flags.push({ kind: "link", label: "link needs a safety check before use", match: url });
      }
    }
  };
  collect(LINK_RE);
  collect(WWW_RE);
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

// Payment by gift card, prepaid card, wire, crypto or a payment app,
// or reading card codes to someone, is a scam signal with or without a
// link. A sentence that warns against it ("we will never ask you to pay
// with gift cards") is not.
const PAYMENT_METHOD =
  /\b(?:gift\s*cards?|prepaid\s+(?:debit\s+)?cards?|wire\s+transfers?|bitcoin|crypto(?:currency)?|zelle|cash\s*app|venmo|western\s+union|moneygram)\b/i;
const PAYMENT_DEMAND = /\b(?:pay|buy|purchase|send|load|wire|transfer|deposit)\b/i;
const CODES_DEMAND = /\b(?:text|call|send|read|give|email)\b[^.!?]{0,60}\b(?:codes|card\s+numbers)\b/i;
const NEGATION = /\b(?:never|not|no|don't|do\s+not|will\s+not|won't)\b/i;

function paymentDemand(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (NEGATION.test(sentence)) continue;
    if ((PAYMENT_METHOD.test(sentence) && PAYMENT_DEMAND.test(sentence)) || CODES_DEMAND.test(sentence)) {
      return sentence.trim();
    }
  }
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
    return [{ kind: "scam", label: "asks for payment by gift card, prepaid card, wire, crypto or a payment app", match: demand }];
  }
  const lower = text.toLowerCase();
  const urgency = URGENCY_WORDS.filter((w) => lower.includes(w));
  if (urgency.length === 0) return [];
  const asksPayment = /pay\b|payment|verify|confirm\s+your|update\s+your\s+(account|information|benefits)/i.test(text);
  if (!asksPayment) return [];
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
