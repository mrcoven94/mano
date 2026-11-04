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
// The same in capitals, as a letter's heading prints it, only on common
// top-level domains: "CASE NO." and "U.S." must never match.
const CAPS_DOMAIN_RE =
  /(?<![@\w.-])(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+(?:COM|NET|ORG|INFO|HELP|ONLINE|SITE|APP|XYZ)(?![\w@-])(?:\/[^\s<>"')\]]*)?/g;
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
  const rest = text.replace(LINK_RE, (m) => " ".repeat(m.length)).replace(WWW_RE, (m) => " ".repeat(m.length));
  collect(BARE_DOMAIN_RE, rest);
  collect(CAPS_DOMAIN_RE, rest);
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

// A government namespace nobody can register in, or a state site that
// real letters print and that sits outside one. A county on a plain .org
// or .com is not listed, so its pay or login link draws the warning, which
// sends the person to their office. A printed name never counts here.
const GOVERNMENT_HOST = /(?:^|\.)(?:gov|mil|fed\.us|state\.[a-z]{2}\.us|(?:co|ci|city|town)\.[a-z0-9-]+\.[a-z]{2}\.us)$/;
const STATE_SITES = new Set([
  "benefitscal.com",
  "yourtexasbenefits.com",
  "coveredca.com",
  "mahealthconnector.org",
  "wahealthplanfinder.org",
  "mnsure.org",
  "pennie.com",
  "connectebt.com",
  "ebtedge.com",
]);

function isOfficial(host: string): boolean {
  return GOVERNMENT_HOST.test(host) || STATE_SITES.has(host.split(".").slice(-2).join("."));
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

// One clause of a sentence. A period or colon inside "$39.00" or a link
// does not end it. A conjunction does, so "Beware of scams and pay $39"
// keeps its demand when the warning is set aside. Patterns cap its length
// so text with no punctuation stays linear: uncapped took 12 s on 20 KB.
const CLAUSE = String.raw`(?:(?!\b(?:and|but|so|then|instead|unless|until|if|or|without)\b)(?:[^.!?,;:\n]|[.:?!](?=\S)))`;
// Clauses that are not a demand on the person: the letter says nothing is
// owed, warns about people who ask, or speaks to whoever reads it, which
// is a planted instruction the reply never carries. Only the clause is
// set aside, so "this is not a scam" clears nothing else in its sentence.
const NOT_ASKED = new RegExp(
  String.raw`\b(?:never|not|no|don't|doesn't|won't)\b(?!\s+(?:forget|delay|ignore|miss|wait|lose|fail)\b)${CLAUSE}{0,160}?` +
    String.raw`\b(?:pay|pays|paying|payment|payments|fees?|charges?|costs?|money|social\s+security|ssn|password|pin|log\s*in|login|verify)\b${CLAUSE}{0,160}`,
  "gi",
);
const WARNS = new RegExp(
  String.raw`${CLAUSE}{0,160}\b(?:scam(?:s|mers?)?|fraud|beware|imposters?|(?:someone|anyone)\s+(?:who|asks?|calls?|says?|claims?|tells?)|tell\s+the\s+(?:resident|person|user|client|recipient))\b${CLAUSE}{0,160}`,
  "gi",
);
// A cost the person pays someone else, not the sender. Set aside unless
// its own clause carries a link, which makes that link the way to pay.
const COST_SHARE = new RegExp(String.raw`${CLAUSE}{0,160}\b(?:co-?pays?|share\s+of\s+cost|spend-?down|deductibles?|medical\s+bills|rent|landlords?|providers?|pharmac(?:y|ies)|utilit(?:y|ies))\b${CLAUSE}{0,160}`, "gi");
// A referral printed on real notices. Its link is not a way to pay, and
// a label's colon does not end it ("Free legal help: lawhelp.example").
const REFERRAL = new RegExp(
  String.raw`${CLAUSE}{0,160}\b(?:legal\s+(?:help|aid|services?|assistance|advice)|lawyers?|attorneys?|interpreters?|civil\s+rights|food\s+(?:banks?|pantr(?:y|ies)))\b(?:[^.!?,;\n]|[.?!](?=\S)){0,160}`,
  "gi",
);

const BENEFITS = String.raw`(?:benefits?|snap|food\s+stamps|calfresh|ebt|medicaid|medi-?cal)`;
// Paying the sender. A mention ("you pay", "your premium is $39"), a
// conditional ("you may have to pay them back"), a list item ("2. Pay
// stubs") and what a benefit pays for are not demands.
const PAY_DEMAND =
  /(?:^|[:;,]\s*|\b(?:and|then|please|now|must|need\s+to|(?<!\bmay\s)have\s+to|required\s+to|forget\s+to|remember\s+to|sure\s+to)\s+)(?:pay|remit)\b(?!\s+(?:nothing|no|attention|stubs?|periods?|dates?|for\s+(?:food|groceries|child\s+care|rent|housing|utilities|heat|energy|medical|health|prescriptions))\b)|\b(?:send|mail)\s+(?:us\s+)?\$\s*\d|\b(?:amount|balance|total)\s+(?:due|owed)\b|\bpayment\s+(?:of\s+\$|is\s+(?:due|required))|\$\s*\d[\d,.]*\s+(?:is\s+)?(?:due|owed|required)\b|\bmake\s+(?:a|your)\s+payment\b|\byou\s+owe\b/im;
// Asking for proof is ordinary, so these need the link beside them: in
// the same sentence, or a next sentence that only points to it. "You can
// also apply online at" is the letter's other way to apply. The office
// verifying something itself is not an ask.
const POINTER = /^(?:go\s+to|visit|click|tap|open|use|follow|here|link)\b|^\S+$/i;
const VERIFY_ASK = new RegExp(
  String.raw`(?<!\b(?:we|county|office|agency|state|caseworker)\s+(?:(?!you\b)\w+\s+){0,5})\b(?:verify|confirm|validate|reactivate|unlock|claim|update)\s+(?:your\s+|the\s+)?(?:[\w$,.-]+\s+){0,2}?(?:${BENEFITS}|account|identity|eligibility|case|card|information|info|details)\b`,
  "i",
);
const SECRET_ASK = /\b(?:log\s*in|login|sign\s*in\s+(?:at|to|here|with)|password|passcode|pin|social\s+security\s+number|ssn|card\s+number|bank\s+account|routing\s+number)\b/i;
// A real office never takes these by text or email, or a PIN any way.
const SECRET_BY_MESSAGE =
  /(?<!\bwe\s+(?:\w+\s+){0,2})\b(?:text|e-?mail|reply\s+with|message|send|give|read|tell)\b[^.!?\n]{0,40}\byour\b[^.!?\n]{0,20}\b(?:pin|password|passcode)\b|\b(?:text|e-?mail|reply\s+with|message)\b[^.!?\n]{0,40}\b(?:social\s+security\s+number|ssn|bank\s+account|routing\s+number)\b/i;
// No government agency charges to renew SNAP or Medicaid. Premiums,
// copays and CHIP enrollment fees are real, and a hearing notice says
// benefits kept during an appeal may have to be paid back.
const REAL_CHARGE = /\bpremiums?\b|co-?pay|share\s+of\s+cost|spend-?down|enrollment\s+fee|deductible|overpa|free\s+of\s+charge|\brepay|\bpa(?:y|id)\s+(?:\w+\s+)?back\b/i;
const NAMED_FEE = /\b(?:processing|renewal|recertification|reinstatement|reactivation|activation|release|verification|unlock)\s+fee\b/i;
// Money the person hands over. An amount alone may be what they receive.
const MONEY = String.raw`(?:\b(?:pay|send|mail|remit)\b[^.!?\n]{0,20}\$\s*\d|\$\s*\d[\d,.]*\s+(?:\w+\s+)?(?:fee|charge|payment)\b|\bfees?\b|\bcharges?\b)`;
const KEEP = String.raw`\bto\s+(?:keep|renew|continue|maintain|reinstate|restore|reactivate|activate|release|unlock)\b`;
const FEE_TO_KEEP = new RegExp(
  String.raw`${MONEY}[^.!?\n]{0,60}${KEEP}[^.!?\n]{0,40}\b${BENEFITS}\b|${KEEP}[^.!?\n]{0,40}\b${BENEFITS}\b[^.!?\n]{0,60}${MONEY}`,
  "i",
);
const NAMES_BENEFITS = new RegExp(String.raw`\b${BENEFITS}\b`, "i");
// Offices no government has, in the words a fake one picks. Real names
// stay out: Ohio has a Department of Medicaid and USCIS a National
// Benefits Center.
const LOOKALIKE_AGENCY =
  /\b(?:u\.?s\.?|united\s+states|federal|national|american|government)\s+(?:benefits?|food\s+benefits?|food\s+stamps?|snap|ebt|medicaid|welfare)\s+(?:department|dept\.?|office|administration|agency|bureau|authority|commission|board)\b|\bdepartment\s+of\s+(?:benefits|food\s+stamps|snap)\b/i;
const DRESSED_AS_GOVERNMENT = /(?:^|[.-])gov(?:t|ernment)?(?:[.-]|$)/;

function firstUnofficialLink(text: string): string | null {
  for (const link of findLinks(text)) {
    const host = hostOf(link.match);
    if (!host || !isOfficial(host)) return link.match;
  }
  return null;
}

// Scams with no urgency word and no untraceable method: what is asked,
// and where the letter sends the person to do it.
function quietScam(text: string): { label: string; match: string } | null {
  const originals = text.split(/(?<=[.!?])\s+|\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const said = originals.map((s) => s.replace(NOT_ASKED, " ").replace(WARNS, " "));
  const find = (test: (s: string) => boolean): string | null => {
    const k = said.findIndex(test);
    return k < 0 ? null : originals[k]!;
  };
  const letter = said.join("\n");
  const reachable = said.map((s) => s.replace(REFERRAL, " "));

  const dressed = findLinks(reachable.join("\n")).find((l) => {
    const host = hostOf(l.match);
    return host && !isOfficial(host) && DRESSED_AS_GOVERNMENT.test(host);
  });
  if (dressed) return { label: "link dressed as a government site", match: dressed.match };
  const lookalike = letter.match(LOOKALIKE_AGENCY);
  if (lookalike) return { label: "names an agency that does not exist", match: lookalike[0] };
  const secret = find((s) => SECRET_BY_MESSAGE.test(s));
  if (secret) return { label: "asks for a Social Security number, PIN or password by message", match: secret };
  if (NAMES_BENEFITS.test(letter)) {
    const fee = find((s) => !REAL_CHARGE.test(s) && (NAMED_FEE.test(s) || FEE_TO_KEEP.test(s)));
    if (fee) return { label: "charges a fee to keep or renew benefits", match: fee };
  }
  const link = firstUnofficialLink(reachable.join("\n"));
  if (link) {
    const demand = find((s) => PAY_DEMAND.test(s.replace(COST_SHARE, (clause) => (findLinks(clause).length > 0 ? clause : " "))));
    if (demand) return { label: "payment demand with an unofficial link", match: link };
  }
  for (const [k, s] of reachable.entries()) {
    if (!VERIFY_ASK.test(s) && !SECRET_ASK.test(s)) continue;
    const next = reachable[k + 1] ?? "";
    const near = firstUnofficialLink(POINTER.test(next.trim()) ? `${s}\n${next}` : s);
    if (near) return { label: "asks to verify benefits or log in at an unofficial link", match: near };
  }
  return null;
}

// Heuristic scam screen over a whole letter, every page together.
// Returns flags; the pipeline turns them into scam_suspect warnings.
// Three signals: a payment demand by an untraceable method; a quiet scam
// (above); or urgency language plus a payment or verification ask plus
// an unofficial link. A printed sender name never exempts a link: it is
// unverified evidence. A real agency letter with a plain phone number
// never matches. These are plain rules on the letter's words. The DNS
// check in packages/channels only knows hosts already on a blocklist, and
// the gate only reads deadlines, so it publishes a scam's "Pay $39 by" as
// readily as a premium's unless this screen flags the letter first.
export function screenScam(text: string): ContentFlag[] {
  const demand = paymentDemand(text);
  if (demand) {
    return [{ kind: "scam", label: "demands payment by gift or prepaid card, wire, crypto or a payment app", match: demand }];
  }
  const quiet = quietScam(text);
  if (quiet) return [{ kind: "scam", ...quiet }];
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
    return !host || !isOfficial(host);
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
