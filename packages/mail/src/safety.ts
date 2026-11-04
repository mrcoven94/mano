// Content safety for mail reading. Letter text is evidence, never
// permission: instructions found inside a letter are reported as
// warnings, never followed. Links and phone numbers are never acted on
// here; they are returned as warnings for the action gateway, which
// checks them before use.

import type { Citation } from "./types.js";

export interface ContentFlag {
  kind: "instruction" | "link" | "phone" | "scam" | "suspect_link";
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

// A browser reads the host and any name before it up to the first / ? # or
// backslash, whatever else is in there, so an apostrophe or quote does not
// end a link until the path starts. Wrapping punctuation is trimmed after.
const LINK_RE = /https?:\/\/[^\s/?#\\]*(?:[/?#\\][^\s<>"')\]]*)?/gi;
const WWW_RE = /\bwww\.(?=[a-z0-9-]+\.)[^\s/?#\\]*(?:[/?#\\][^\s<>"')\]]*)?/gi;
// A name and an @ before a bare host: an email address never has a path or a
// password, and a personal one does not end its name in a top-level domain.
// A label run into an address ("Email:maria@county.gov") is not a password.
const BARE_USERINFO_RE =
  /(?<![\w.@/-])(?!(?:e-?mail|mailto|contact|to|from|cc|reply-to):)[A-Za-z0-9](?:[^\s@/<>"]{0,100}\.(?:gov|mil|com|org|net|us|info|help)(?=@)|[^\s@/<>":]{0,100}:[^\s@/<>"]{0,100}(?=@)|[^\s@/<>"]{0,100}(?=@[^\s@/]+\/))@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}(?:\/[^\s<>"')\]]*)?/gi;
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

// Words are read with links masked, so a word in a link
// ("/scam-prevention", "lawyers-fee.example") is never read as prose.
const LINK_HOLE = /\uE000(\d+)\uE001/g;

function maskLinks(text: string): { masked: string; links: string[] } {
  const links: string[] = [];
  let masked = text;
  for (const re of [LINK_RE, WWW_RE, BARE_USERINFO_RE, BARE_DOMAIN_RE, CAPS_DOMAIN_RE]) {
    masked = masked.replace(re, (m) => {
      const url = m.replace(/[.,;:!?)\]'">]+$/, "");
      links.push(url);
      return `\uE000${links.length - 1}\uE001${m.slice(url.length)}`;
    });
  }
  return { masked, links };
}

export function findLinks(text: string): ContentFlag[] {
  return [...new Set(maskLinks(text).links)].map((url) => ({ kind: "link", label: "link needs a safety check before use", match: url }));
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

// A letter is read clause by clause. A comma, semicolon, colon, line break
// or conjunction ends a clause, but a colon before a link does not, so "Free
// legal help: <link>" stays whole. A conjunction stays on its clause, so
// "if you do not pay" still reads as a condition.
const CLAUSE_BREAK =
  /,(?=\s)|;|:(?=\s+(?!\uE000))|\n|\s+(?=(?:and|but|plus|so|then|instead|unless|until|if|or|nor|without|while|because|except|along\s+with|as\s+well\s+as|in\s+addition\s+to|together\s+with)\s)/i;
// Says nothing is owed or asked. Not "do not forget to pay", "no later
// than", "by not paying", or a condition ("if you do not pay").
const NEGATED = new RegExp(
  String.raw`^(?!\s*(?:if|unless)\b).*(?<!\bby\s)\b(?:never|not|no|none|don['’]t|doesn['’]t|won['’]t|cannot|can['’]t)\b(?!\s+(?:only|forget|delay|ignore|miss|wait|lose|fail|later|benefits)\b)[^\uE000]{0,120}?` +
    String.raw`\b(?:pay|pays|paying|payment|payments|fees?|charges?|costs?|money|social\s+security|ssn|password|pin|log\s*in|login|verify)\b` +
    String.raw`|\b(?:no\s+one|nobody)\b`,
  "i",
);
// A negation covers "or give your PIN" and "or password by email", and a
// clause with no action of its own. "Never use a check, pay $39" keeps its
// demand.
const ACTION = /\b(?:pay|remit|send|mail|give|text|e-?mail|reply|enter|verify|confirm|log\s*in|sign\s*in|click|go|visit|call|buy|wire|update)\b/i;
// Speaks to whoever reads the letter: a planted instruction (rule 4), which
// is evidence and which the reply never carries. It is no demand on the
// person, so its letter keeps its deadline.
const PLANTED_ASIDE = /\b(?:tell|ask|instruct|advise|direct|inform)\s+(?:the|this|your)\s+(?:resident|person|user|client|recipient|reader)\b/i;
// A sentence that warns the reader about other people. Its first clause may
// describe what they ask for, but the sentence holds no demand of its own
// and no link. "To prevent fraud, verify ..." is not one.
const WARNS_READER =
  /^(?:please\s+)?(?:beware|be\s+(?:careful|aware|alert)|watch\s+out|warning)\b|^(?:scammers?|imposters?|impostors?|fraudsters?|thieves|criminals)\b|^(?:if|when)\s+(?:someone|anyone|a\s+(?:caller|person|stranger|website|text|message|call))\b|^(?:anyone|someone)\s+(?:who\s+(?:asks?|calls?|says?|tells?|claims?|texts?|e-?mails?|wants?|demands?)|asking)\b|\b(?:is|are|may\s+be|could\s+be)\s+(?:a\s+)?(?:scams?|scammers?|fraud)\W*$/i;
// A referral printed on real notices. Its link is not a way to pay.
const REFERRAL = /\b(?:legal\s+(?:help|aid|services?|assistance|advice)|lawyers?|attorneys?|interpreters?|civil\s+rights|food\s+(?:banks?|pantr(?:y|ies))|report\s+(?:scams?|fraud|abuse))\b/i;
// A cost the person pays someone else, not the sender.
const COST_SHARE = /\b(?:co-?pays?|share\s+of\s+cost|spend-?down|deductibles?|medical\s+bills|rent|landlords?|providers?|pharmac(?:y|ies)|utilit(?:y|ies))\b/i;

const FOOD = String.raw`(?:snap|food\s+stamps|food\s+benefits?|food\s+assistance|basic\s+food|calfresh|ebt)`;
const BENEFITS = String.raw`(?:benefits?|${FOOD}|medicaid|medi-?cal)`;
const AMOUNT = String.raw`(?:\$\s*[1-9][\d,]*(?:\.\d{1,2})?|\b(?:[1-9][\d,]*(?:\.\d{2})?|[a-z]+(?:-[a-z]+)?)\s+(?:dollars|usd)\b)`;
const NOT_A_PAYMENT = String.raw`(?!\s+(?:nothing|no|attention|stubs?|periods?|dates?|for\s+(?:food|groceries|child\s+care|rent|housing|utilities|heat|energy|medical|health|prescriptions))\b)`;
// Paying the sender. A mention ("you pay", "your premium is $39"), a
// conditional ("you may have to pay them back"), a list item ("2. Pay
// stubs") and what a benefit pays for are not demands.
const PAY_DEMAND = new RegExp(
  String.raw`^(?:(?:and|then|please|now|but|or|so|just|simply|also|first)\s+)*(?:pay|remit)\b${NOT_A_PAYMENT}` +
    String.raw`|\b(?:must|needs?\s+to|(?<!\bmay\s)have\s+to|has\s+to|required\s+to|forget\s+to|remember\s+to|sure\s+to)\s+(?:pay|remit)\b${NOT_A_PAYMENT}` +
    String.raw`|(?<!\b(?:you|they|we|who|may|can|will|would|to|not)\s)\bpay\s+\$\s*\d` +
    String.raw`|\b(?:send|mail)\s+(?:us\s+)?\$\s*\d|\b(?:amount|balance|total)\s+(?:due|owed)\b|\bpayment\s+(?:of\s+\$|is\s+(?:due|required))` +
    String.raw`|\$\s*\d[\d,.]*\s+(?:is\s+)?(?:due|owed|required)\b|\bmake\s+(?:a|your)\s+payment\b|\byou\s+owe\b`,
  "i",
);
// A link given as the way to pay, however softly it is put.
const PAY_ROUTE = new RegExp(String.raw`(?<!\b(?:benefits?|help|helps|you)\s)\bpay(?:ments?)?\b${NOT_A_PAYMENT}[^\uE000]{0,80}\uE000`, "i");
// Asking for proof is ordinary, so these need the link beside them: in
// the same sentence, or a next sentence that only points to it. "You can
// also apply online at" is the letter's other way to apply. The office
// verifying something itself is not an ask, and a header above an ask is
// not its subject, so a named office counts only with a verb of its own.
const POINTER = /^(?:go\s+to|visit|click|tap|open|use|follow|here|link)\b|^\S+$/i;
const VERIFY_ASK = new RegExp(
  String.raw`(?<!\bwe\s+(?:(?!you\b)\w+\s+){0,5}|\b(?:county|office|agency|state|caseworker|department)\s+(?:will|must|may|can|needs?\s+to|has\s+to|wants?\s+to)\s+(?:\w+\s+){0,2})` +
    String.raw`\b(?:verify|confirm|validate|reactivate|unlock|claim|update)\s+(?:your\s+|the\s+)?(?:[\w$,.-]+\s+){0,2}?(?:${BENEFITS}|account|identity|eligibility|case|card|information|info|details)\b`,
  "i",
);
const SECRET_ASK = /\b(?:log\s*in|login|sign\s*in\s+(?:at|to|here|with)|password|passcode|pin|social\s+security\s+number|ssn|card\s+number|bank\s+account|routing\s+number)\b/i;
// A real office never takes these by text or email, or a PIN any way. The
// method may come before or after the secret, and an email address or phone
// number is a method. A letter saying the office will send one is not an ask.
const MESSAGED_SECRET = String.raw`(?:social\s+security\s+(?:number|no\.?|#)|s\.?s\.?n\b\.?|ss#|bank\s+account(?:\s+number)?|routing\s+number|pin|password|passcode|ebt\s+card\s+number)`;
const HANDED_SECRET = String.raw`(?:pin|password|passcode|ebt\s+card\s+number)`;
const HANDING = String.raw`(?:send|sending|provide|give|share|submit|confirm|verify|enter|include|forward|(?:must|should|needs?\s+to|has\s+to|have\s+to)\s+be\s+sent)`;
const MESSAGE_APP = String.raw`(?:\b(?:by|via|through|over|in\s+an?|using|on)\s+(?:a\s+)?(?:text(?:\s+message)?|e-?mail|sms|message|whatsapp|telegram|messenger)\b)`;
const ADDRESS = String.raw`\bto\s+(?:[^\s@]+@[^\s@]+|\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})`;
const NOT_THE_SECRET = String.raw`(?:(?!\b(?:about|for|regarding|if)\b).)`;
const SECRET_BY_MESSAGE = new RegExp(
  String.raw`\b${HANDING}\b.{0,40}?\b${MESSAGED_SECRET}.{0,80}${MESSAGE_APP}|${MESSAGE_APP}.{0,40}\b${HANDING}\b.{0,40}?\b${MESSAGED_SECRET}|${MESSAGED_SECRET}.{0,40}\b(?:must|should|needs?\s+to|has\s+to|have\s+to)\s+be\s+sent\b.{0,40}${MESSAGE_APP}` +
    String.raw`|\b(?:send|sending|give|share|forward)\b${NOT_THE_SECRET}{0,40}?\b${MESSAGED_SECRET}.{0,40}${ADDRESS}` +
    String.raw`|\b(?:text|e-?mail|message|sms|reply(?:\s+to\s+this\s+\w+)?\s+with)\s+(?:(?!about\b|for\b|regarding\b|on\b|if\b)\S+\s+){0,4}?\b${MESSAGED_SECRET}` +
    String.raw`|\b(?:send|give|read|tell|share)\b${NOT_THE_SECRET}{0,40}\byour\b.{0,20}\b${HANDED_SECRET}\b`,
  "i",
);
const OFFICE_SENDS = /^\s*(?:we\s+(?:will|may|can)\s+(?:send|text|e-?mail|mail|message)\s+(?:you|your|a|an|the)\b|your\s+(?:new\s+)?(?:pin|password|passcode)\s+will\s+be\s+sent\b)/i;
// No government agency charges to renew SNAP or Medicaid, so a fee or an
// amount for that counts. A clause naming a real charge is about that charge,
// amount and purpose included, so it leaves the reading whole, unless a fee
// of its own remains. Real charges apply only where they exist. Food benefits
// have no premium or copay, and only some health programs have an enrollment
// fee.
const NO_FEE_AT_ALL = /\bfree\s+of\s+charge\b|\bfee\s+waivers?\b/gi;
// Evidence of what the person pays, not a payment to the sender.
const ASKS_FOR_PROOF = /\b(?:proof|evidence|receipts?|cop(?:y|ies)\s+of|show\s+that)\b/i;
const RENT_CHARGE = /\brent\s+(?:fees?|charges?)\b/gi;
const ALWAYS_REAL = /\boverpa\w+|\brepay\w*|\bpa(?:y|id)\s+(?:\w+\s+)?back\b|\brent\b|\bchild\s+support\b/i;
const HEALTH_CHARGE = /\b(?:premiums?|co-?pay(?:s|ments?)?|coinsurance|share\s+of\s+cost|spend-?down|deductibles?|(?:family|parent)\s+(?:fee|charge))\b/i;
const NAMED_REAL_FEE = /\b(?:premiums?|co-?pay(?:s|ments?)?|coinsurance|share\s+of\s+cost|spend-?down|deductibles?|family|parent)\s+(?:fees?|charges?)\b/gi;
const ENROLLMENT_FEE = /\benrollment\s+(?:fee|charge)\b/gi;
const CHARGES_ENROLLMENT = /\b(?:chip|medicaid|kidscare|peachcare)\b/i;
const NAMES_FOOD = new RegExp(String.raw`\b${FOOD}\b`, "i");
const NAMES_HEALTH = /\b(?:medicaid|medi-?cal|chip|health\s+coverage)\b/i;
const FOOD_PURPOSE = new RegExp(String.raw`^to\s+\w+.{0,40}\b${FOOD}\b`, "i");
// A fee to someone else, or for a card, not to stay on the program.
const OTHER_FEE = /\b(?:atms?|withdrawals?|surcharges?|transactions?|replacement|stores?|banks?|retailers?)\b/i;
const NAMED_FEE_WORDS = String.raw`(?:processing|renewal|recertification|reinstatement|reactivation|activation|release|verification|unlock|enrollment)\s+fee`;
const NAMED_FEE = new RegExp(String.raw`\b${NAMED_FEE_WORDS}\b`, "i");
// A fee clause that names nothing else, in a letter about benefits. "Your
// vehicle registration renewal fee" or "fee for copies" names something else.
const BARE_FEE = new RegExp(
  String.raw`^(?:(?:and|plus|without|with|but|then|so)\s+)?(?:(?:you\s+(?:must|need\s+to|have\s+to)|please)\s+)?(?:(?:pay|send|remit)\s+)?(?:(?:a|an|the|this|your|one-time)\s+){0,3}(?:${AMOUNT}\s+)?(?:one-time\s+)?${NAMED_FEE_WORDS}(?:\s+of\s+${AMOUNT}|\s+${AMOUNT})?(?:\s+(?:is|are|must\s+be)(?:\s+${AMOUNT}|\s+(?:required|due|needed|paid|owed))?|\s+applies)?(?:\s+(?:at|by|to|online|now|today|first)\b.*)?\W*$`,
  "i",
);
const NO_CHARGE = /^(?:\$\s*0(?:\.00)?|none|waived|n\/a|free)\b/i;
const ANY_FEE = /(?<!\bin\s)\b(?:fees?|charges?)\b/i;
// Money handed over. "Send your $120 rent receipt" and "your pay of $300"
// name a paper or an income, not a payment.
const HAND_OVER = new RegExp(
  String.raw`(?<!\b(?:your|my|take-home|monthly|gross|net)\s)\b(?:pays?|paying)\b${NOT_A_PAYMENT}.{0,30}?(?:${AMOUNT}|\bfees?\b|\bcharges?\b)` +
    String.raw`|\b(?:sends?|sending|mails?|remits?|wires?)\s+(?:us\s+|in\s+|a\s+|a\s+total\s+of\s+|a\s+payment\s+of\s+)?${AMOUNT}|\b(?:sends?|mails?|remits?)\b.{0,20}\b(?:fees?|payment|money)\b` +
    String.raw`|${AMOUNT}\s+(?:\S+\s+){0,2}?(?:fees?|charges?|payment)\b|${AMOUNT}\s+(?:is|are)\s+(?:required|due|owed|needed)\b|\b(?:payment|fee)\s+of\s+${AMOUNT}|\bcosts?\s+${AMOUNT}|\b(?:fees?|charges?)\b.{0,30}\b(?:required|due|owed|needed|must\s+be\s+paid)\b` +
    String.raw`|^(?:please\s+)?(?:renew|keep|reinstate|restore|reactivate|unlock)\b.{0,40}\bfor\s+${AMOUNT}`,
  "i",
);
// Keeping a program going, in any form of the verb. "Renewal" is a noun
// that names papers and other bills, so it does not count.
const TO_KEEP = new RegExp(
  String.raw`\b(?:keep(?:s|ing)?|renew(?:s|ing)?|continu(?:e|es|ing)|maintain(?:s|ing)?|reinstat(?:e|es|ing)|restor(?:e|es|ing)|reactivat(?:e|es|ing)|activat(?:e|es|ing)|releas(?:e|es|ing)|unlock(?:s|ing)?)\b.{0,40}\b${BENEFITS}\b`,
  "i",
);
const THREAT = /\b(?:unless|until|without|failure\s+to|fail\s+to|if\s+you\s+(?:do\s+not|don['’]t))\b|\b(?:will|would|may|can)\s+(?:not\s+)?(?:end|stop|close|lose|be\s+\w+ed)\b|\blose\s+your\b/i;
const NAMES_BENEFITS = new RegExp(String.raw`\b${BENEFITS}\b`, "i");
// Offices no government has, in the words a fake one picks. Real names
// stay out: Ohio has a Department of Medicaid and USCIS a National
// Benefits Center.
const LOOKALIKE_AGENCY =
  /\b(?:u\.?s\.?|united\s+states|federal|national|american|government)\s+(?:benefits?|food\s+benefits?|food\s+stamps?|snap|ebt|medicaid|welfare)\s+(?:department|dept\.?|office|administration|agency|bureau|authority|commission|board)\b|\bdepartment\s+of\s+(?:benefits|food\s+stamps|snap)\b/i;
const DRESSED_AS_GOVERNMENT = /(?:^|[.-])gov(?:t|ernment)?(?:[.-]|$)/;

// A link built to hide where it goes: a name before the @ sign, a bare
// address, a host with marks no real name has, a lookalike letter, a
// government name in the wrong place, or something a browser cannot even
// read. No real office prints one.
function hidesWhereItGoes(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link.includes("://") ? link : `https://${link}`);
  } catch {
    return true;
  }
  if (url.username || url.password) return true;
  const host = url.hostname.toLowerCase();
  if (isOfficial(host)) return false;
  return /[^a-z0-9.-]|^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes("xn--") || DRESSED_AS_GOVERNMENT.test(host) || /\.gov(?:[/?#]|$)/i.test(url.pathname + url.search);
}

function isUnofficial(link: string): boolean {
  const host = hostOf(link);
  return !host || !isOfficial(host);
}

interface Sentence {
  original: string;
  // The clauses that ask something of the person.
  clauses: string[];
  // Without referrals, whose links are not where a demand sends anyone.
  reachable: string;
}

// A letter's sentences, read with its links masked.
interface Reading {
  sentences: Sentence[];
  links: string[];
  // Every clause that asks something of the person, one per line.
  said: string;
}

function readLetter(masked: string, links: string[]): Reading {
  const unmask = (s: string): string => s.replace(LINK_HOLE, (_m, k: string) => links[Number(k)]!);
  // "S.S.N." and "Social Security no." do not end a sentence.
  const parts = masked.split(/(?<=[.!?])(?<!\bno\.|\bs\.s\.n\.)\s+|\n\s*\n/i).map((s) => s.trim()).filter(Boolean);
  const clausesOf = (s: string): string[] => s.split(CLAUSE_BREAK).map((c) => c.trim()).filter(Boolean);
  const warns = (s: string): boolean => {
    const [first, ...rest] = clausesOf(s);
    return (
      WARNS_READER.test(s) &&
      !/\uE000/.test(s) &&
      !PAY_DEMAND.test(first ?? "") &&
      !rest.some((c) => PAY_DEMAND.test(c) || HAND_OVER.test(c) || /\$\s*\d/.test(c))
    );
  };
  const sentences = parts.map((part, i) => {
    // "Asked to pay a fee? It is a scam." The question is part of the warning.
    const warning = warns(part) || (part.endsWith("?") && warns(parts[i + 1] ?? ""));
    const kept: string[] = [];
    let negated = false;
    for (const clause of warning ? [] : clausesOf(part)) {
      if (PLANTED_ASIDE.test(clause)) continue;
      if (NEGATED.test(clause)) {
        negated = true;
        continue;
      }
      if (negated && (/^(?:or|nor)\b/i.test(clause) || !ACTION.test(clause))) continue;
      negated = false;
      kept.push(clause);
    }
    return { original: unmask(part), clauses: kept, reachable: kept.filter((c) => !REFERRAL.test(c)).join("\n") };
  });
  return { sentences, links, said: sentences.flatMap((s) => s.clauses).join("\n") };
}

function linksIn(text: string, links: string[]): string[] {
  return [...text.matchAll(LINK_HOLE)].map((m) => links[Number(m[1])]!);
}

// The clause as a charge for anything else, or null if it only names a real
// charge. "Your premium payment of $25.00 is required" is null, and "Your
// $39 premium includes a $25 fee to renew" keeps its fee.
function chargedFor(clause: string, food: boolean, chargesEnrollment: boolean): string | null {
  let rest = clause.replace(NO_FEE_AT_ALL, " ").replace(RENT_CHARGE, " rent ");
  let real = ALWAYS_REAL.test(rest) || ASKS_FOR_PROOF.test(rest);
  if (!food) {
    real ||= HEALTH_CHARGE.test(rest);
    rest = rest.replace(NAMED_REAL_FEE, " ");
    if (chargesEnrollment && ENROLLMENT_FEE.test(rest)) {
      real = true;
      rest = rest.replace(ENROLLMENT_FEE, " ");
    }
  }
  return real && !ANY_FEE.test(rest) ? null : rest;
}

// Whether a clause's charge is on food benefits: it names them, or it names no
// health program and the clause beside it says that is what the charge is for
// ("To keep your CalFresh, pay your $10 copay"). "Pay your Medicaid premium,
// and return the SNAP form" is a real charge beside a food form.
function onFood(clause: string, before: string | undefined, after: string | undefined): boolean {
  if (NAMES_FOOD.test(clause)) return true;
  if (NAMES_HEALTH.test(clause)) return false;
  return [before, after].some((c) => c !== undefined && FOOD_PURPOSE.test(c));
}

function feeToKeep({ sentences, said }: Reading): string | null {
  if (!NAMES_BENEFITS.test(said)) return null;
  const chargesEnrollment = CHARGES_ENROLLMENT.test(said);
  for (const sentence of sentences) {
    const clauses = sentence.clauses
      .filter((c) => !OTHER_FEE.test(c))
      .map((c, k, all) => chargedFor(c, onFood(c, all[k - 1], all[k + 1]), chargesEnrollment))
      .filter((c): c is string => c !== null);
    // What was charged comes from what is left. What it was for may be in
    // a real charge's clause: "Pay a $25 fee plus your premium to keep ..."
    const purpose = sentence.clauses.join(" ");
    const charged =
      clauses.some((c, k) => !NO_CHARGE.test(clauses[k + 1] ?? "") && ((ANY_FEE.test(c) && TO_KEEP.test(c)) || (NAMED_FEE.test(c) && NAMES_BENEFITS.test(c)) || BARE_FEE.test(c))) ||
      (clauses.some((c) => HAND_OVER.test(c)) && (TO_KEEP.test(purpose) || (NAMES_BENEFITS.test(purpose) && THREAT.test(purpose))));
    if (charged) return sentence.original;
  }
  return null;
}

// Asks no real office makes, or a sender that is not one. A link is not
// needed for any of these.
function clearScam(reading: Reading): ContentFlag | null {
  const { sentences, links, said } = reading;
  const scam = (label: string, match: string): ContentFlag => ({ kind: "scam", label, match });
  const hiding = sentences.flatMap((s) => linksIn(s.clauses.join("\n"), links)).find(hidesWhereItGoes);
  if (hiding) return scam("link that hides where it goes", hiding);
  const lookalike = said.match(LOOKALIKE_AGENCY);
  if (lookalike) return scam("names an agency that does not exist", lookalike[0]);
  const secret = sentences.find((s) => {
    // A fax is a real way to send one, and only the clause that says so.
    const whole = s.clauses.filter((c) => !/\bfax/i.test(c)).join(" ");
    return !OFFICE_SENDS.test(whole) && SECRET_BY_MESSAGE.test(whole);
  });
  if (secret) return scam("asks for a Social Security number, PIN or password by message", secret.original);
  const fee = feeToKeep(reading);
  if (fee) return scam("charges a fee to keep or renew benefits", fee);
  return null;
}

// Pressure to pay or verify, with an unofficial link or a warning off the
// person's own office.
function urgentScam({ sentences, links, said }: Reading): ContentFlag | null {
  const lower = said.toLowerCase();
  const urgency = URGENCY_WORDS.filter((w) => lower.includes(w));
  if (urgency.length === 0) return null;
  // "Send your pay stubs right away" or "so we can verify your income" is
  // ordinary, whatever link the letter also prints.
  const asks = /\bverify\s+now\b/i.test(said) || VERIFY_ASK.test(said) || SECRET_ASK.test(said) || said.split("\n").some((c) => PAY_DEMAND.test(c));
  if (!asks) return null;
  const detail = `urgency words: ${urgency.slice(0, 3).join(", ")}`;
  // A real office never tells the person not to contact it.
  const cutOff = sentences.map((s) => s.original.match(/\b(?:do\s+not|don't|never)\s+(?:call|contact|phone|visit)\s+(?:the\s+|your\s+)?(?:county|office|agency|state|caseworker|benefits\s+office)\b[^.!?\n]*/i)).find(Boolean);
  if (cutOff) return { kind: "scam", label: "urgent verification ask that tells the person not to contact their office", match: cutOff[0], detail };
  const link = sentences.flatMap((s) => linksIn(s.reachable, links)).find(isUnofficial);
  if (!link) return null;
  return { kind: "scam", label: "urgent payment or verification ask with an unofficial link", match: link, detail };
}

// An ordinary ask (pay, verify, log in, give a Social Security number)
// that real offices make too, sent to a link that cannot be vouched for.
// Only the link is suspect: a county on a plain .org or a premium's
// payment vendor reads the same, so the person is warned off the link and
// told to check the date, which stays out of Mano's deadlines.
function suspectLink({ sentences, links }: Reading): ContentFlag | null {
  const link = sentences.flatMap((s) => linksIn(s.reachable, links)).find(isUnofficial);
  if (!link) return null;
  // A cost paid to someone else is no demand, unless its own clause carries
  // the link, which makes that link the way to pay.
  const pays = sentences.some((s) =>
    s.clauses.some((c) => (PAY_DEMAND.test(c) && (!COST_SHARE.test(c) || /\uE000/.test(c))) || (PAY_ROUTE.test(c) && !REFERRAL.test(c) && linksIn(c, links).some(isUnofficial))),
  );
  if (pays) return { kind: "suspect_link", label: "payment demand with an unofficial link", match: link };
  for (const [k, s] of sentences.entries()) {
    if (!VERIFY_ASK.test(s.reachable) && !SECRET_ASK.test(s.reachable)) continue;
    const next = sentences[k + 1]?.reachable ?? "";
    const near = linksIn(POINTER.test(next.trim()) ? `${s.reachable}\n${next}` : s.reachable, links).find(isUnofficial);
    if (near) return { kind: "suspect_link", label: "asks to verify benefits or log in at an unofficial link", match: near };
  }
  return null;
}

// One pass, so no pattern below ever walks a long run of whitespace. Line
// breaks still end a clause, and a blank line still ends a sentence.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, (run) => {
    const breaks = run.split("\n").length - 1;
    return breaks === 0 ? " " : breaks === 1 ? "\n" : "\n\n";
  });
}

// Heuristic scam screen over a whole letter, every page together.
// Returns at most one flag, the clearest. The pipeline turns "scam" into a
// scam_suspect warning, and "suspect_link" into a link_suspect warning. Mano
// holds no date from either, and the reply names one only as a claim. A
// printed sender name never exempts a link: it is
// unverified evidence. A real agency letter with a plain phone number
// never matches. These are plain rules on the letter's words. The DNS
// check in packages/channels only knows hosts already on a blocklist, and
// the gate only reads deadlines, so it publishes a scam's "Pay $39 by" as
// readily as a premium's unless this screen flags the letter first.
export function screenScam(text: string): ContentFlag[] {
  const { masked, links } = maskLinks(collapseWhitespace(text));
  const demand = paymentDemand(masked);
  if (demand) {
    return [{ kind: "scam", label: "demands payment by gift or prepaid card, wire, crypto or a payment app", match: demand.replace(LINK_HOLE, (_m, k: string) => links[Number(k)]!) }];
  }
  const reading = readLetter(masked, links);
  const flag = clearScam(reading) ?? urgentScam(reading) ?? suspectLink(reading);
  return flag ? [flag] : [];
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
