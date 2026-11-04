import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { base64ToBytes, sha256Hex } from "../hash.js";
import type { ActionRequest } from "./types.js";
import { DefiniteFailureError, TimeoutError } from "./types.js";

// What faxes and mailed letters share: the frozen payload they carry, the
// price the person reads before their yes, and the PDF that goes out.
// Rule 2 limits where they can go. Each has one fixed recipient, named for
// the person in @mano/protocol, and a request for anything else is refused:
// the fax goes only to our own number, the letter only to the provider's
// test mode, where nothing is printed or mailed.
export const FAX_RECIPIENT = "mano-test-fax-line";
export const MAIL_RECIPIENT = "mano-practice-mailbox";

export type OutboundType = "fax" | "mail";

// The payload keys the approval question prints as they are, so they read
// as words: "Price: $0.85, not charged in practice".
export const PAYLOAD = {
  faxTo: "Fax to",
  mailTo: "Mail to",
  returnAddress: "Return address",
  approvedBy: "Approved by",
  pages: "Pages",
  price: "Price",
} as const;

// A page is what the person is charged for, so the cover page counts, and
// so does the blank page a mailed letter's address is printed on.
const EXTRA_PAGES: Record<OutboundType, number> = { fax: 1, mail: 2 };
// The mail provider takes 6 sheets in a standard envelope.
const MAX_PAGES: Record<OutboundType, number> = { fax: 20, mail: 6 };

export interface OutboundPricing {
  faxCentsPerPage: number;
  mailBaseCents: number;
  mailCentsPerExtraPage: number;
}

// Estimates from the providers' published prices. An operator overrides
// them with the MANO_*_CENTS settings once the real rates are known.
export const DEFAULT_PRICING: OutboundPricing = { faxCentsPerPage: 2, mailBaseCents: 85, mailCentsPerExtraPage: 10 };

export function outboundPricing(env: OutboundEnv): OutboundPricing {
  const cents = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return value && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    faxCentsPerPage: cents(env.MANO_FAX_CENTS_PER_PAGE, DEFAULT_PRICING.faxCentsPerPage),
    mailBaseCents: cents(env.MANO_MAIL_BASE_CENTS, DEFAULT_PRICING.mailBaseCents),
    mailCentsPerExtraPage: cents(env.MANO_MAIL_CENTS_PER_EXTRA_PAGE, DEFAULT_PRICING.mailCentsPerExtraPage),
  };
}

// No billing exists yet and nothing here reaches a real office, so the
// question says what it would cost and that this one costs the person nothing.
export function priceText(type: OutboundType, pages: number, pricing: OutboundPricing): string {
  const cents = type === "fax" ? pages * pricing.faxCentsPerPage : pricing.mailBaseCents + (pages - 1) * pricing.mailCentsPerExtraPage;
  const amount = `$${(cents / 100).toFixed(2)}`;
  return type === "fax" ? `${amount}, not charged on the test line` : `${amount}, not charged in practice`;
}

export function isOutbound(type: unknown): type is OutboundType {
  return type === "fax" || type === "mail";
}

const LETTER = { width: 612, height: 792 };
const MARGIN = 36;

type DocumentKind = "pdf" | "png" | "jpg";

function kindOf(bytes: Uint8Array): DocumentKind | null {
  const starts = (magic: number[]) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpg";
  return null;
}

// How many pages go out for this document, or null when it cannot be read.
export async function outgoingPages(type: OutboundType, bytes: Uint8Array): Promise<number | null> {
  const kind = kindOf(bytes);
  if (!kind) return null;
  if (kind !== "pdf") return 1 + EXTRA_PAGES[type];
  try {
    return (await PDFDocument.load(bytes)).getPageCount() + EXTRA_PAGES[type];
  } catch {
    return null;
  }
}

// Sets the pages and price on a fax or letter from the stored document,
// over whatever the caller wrote, so the question shows Engine's own
// numbers. Anything else, or a document it cannot read, passes through
// unchanged and the executor refuses it.
export async function withOutboundPrice(
  raw: unknown,
  readDocument: (id: string) => Promise<Uint8Array | string | null>,
  pricing: OutboundPricing,
): Promise<unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const { type, documentId, payload } = raw as { type?: unknown; documentId?: unknown; payload?: unknown };
  if (!isOutbound(type) || typeof documentId !== "string" || typeof payload !== "object" || payload === null) return raw;
  let stored: Uint8Array | string | null;
  try {
    stored = await readDocument(documentId);
  } catch {
    // The gateway reads it again and reports the storage problem.
    return raw;
  }
  if (stored == null) return raw;
  const pages = await outgoingPages(type, typeof stored === "string" ? new TextEncoder().encode(stored) : stored);
  if (pages === null) return raw;
  return { ...raw, payload: { ...payload, [PAYLOAD.pages]: pages, [PAYLOAD.price]: priceText(type, pages, pricing) } };
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Rule 3: what goes out says who prepared it and whose yes sent it. It
// sits on its own page so it never covers the person's document.
export function attestation(name: string): string {
  return `Prepared with Mano, sent with ${name}'s approval.`;
}

function drawCover(page: PDFPage, font: PDFFont, bold: PDFFont, req: ActionRequest, name: string, documentHash: string): void {
  const width = LETTER.width - 2 * MARGIN;
  let y = LETTER.height - 2 * MARGIN;
  const write = (text: string, size: number, using: PDFFont) => {
    for (const line of wrap(text, using, size, width)) {
      page.drawText(line, { x: MARGIN, y, size, font: using });
      y -= size * 1.5;
    }
    y -= size * 0.75;
  };
  write(attestation(name), 16, bold);
  write("Mano is an automated assistant, not a person. It prepared this document and sent it only after the person named above answered yes to this exact version.", 11, font);
  write(`About: ${req.purpose}`, 11, font);
  write(`Document fingerprint (SHA-256): ${documentHash}`, 9, font);
}

function fitted(box: { width: number; height: number }): { x: number; y: number; xScale: number; yScale: number } {
  const room = { width: LETTER.width - 2 * MARGIN, height: LETTER.height - 2 * MARGIN };
  const scale = Math.min(room.width / box.width, room.height / box.height);
  return {
    x: (LETTER.width - box.width * scale) / 2,
    y: (LETTER.height - box.height * scale) / 2,
    xScale: scale,
    yScale: scale,
  };
}

// The cover page, then each page of the document fitted to US Letter,
// which both providers accept. The same request always renders the same
// bytes, so a retry sends what the first try sent.
async function renderOutgoing(req: ActionRequest, name: string, bytes: Uint8Array, documentHash: string): Promise<Uint8Array> {
  const kind = kindOf(bytes);
  if (!kind) throw new Error("unsupported document");
  const out = await PDFDocument.create();
  const [font, bold] = await Promise.all([out.embedFont(StandardFonts.Helvetica), out.embedFont(StandardFonts.HelveticaBold)]);
  drawCover(out.addPage([LETTER.width, LETTER.height]), font, bold, req, name, documentHash);
  if (kind === "pdf") {
    const source = await PDFDocument.load(bytes);
    const pages = await out.embedPdf(source, source.getPageIndices());
    for (const page of pages) {
      const { x, y, xScale, yScale } = fitted(page);
      out.addPage([LETTER.width, LETTER.height]).drawPage(page, { x, y, xScale, yScale });
    }
  } else {
    const image = kind === "png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const { x, y, xScale, yScale } = fitted(image);
    out.addPage([LETTER.width, LETTER.height]).drawImage(image, { x, y, width: image.width * xScale, height: image.height * yScale });
  }
  const fixed = new Date(0);
  out.setCreationDate(fixed);
  out.setModificationDate(fixed);
  out.setProducer("Mano");
  out.setCreator("Mano");
  return out.save();
}

export type Outgoing = { ok: true; name: string; pdf: Uint8Array } | { ok: false; problem: string };

// Everything a fax and a letter must have, checked before the question
// and again right before sending: a document, a name for the attestation,
// and the pages and price Engine works out for these exact bytes.
export async function prepareOutgoing(req: ActionRequest, type: OutboundType, pricing: OutboundPricing): Promise<Outgoing> {
  const what = type === "fax" ? "fax" : "letter";
  if (!req.document) return { ok: false, problem: `A ${what} needs a document to send.` };
  const name = req.payload[PAYLOAD.approvedBy];
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, problem: `A ${what} needs the name of the person approving it, to print on it.` };
  }
  const bytes = base64ToBytes(req.document.bytesB64);
  const pages = await outgoingPages(type, bytes);
  if (pages === null) return { ok: false, problem: `Mano can only send a PDF, PNG or JPG it can open, and it could not open this document.` };
  if (pages > MAX_PAGES[type]) return { ok: false, problem: `This ${what} would be ${pages} pages, and Mano can send at most ${MAX_PAGES[type]}.` };
  if (req.payload[PAYLOAD.pages] !== pages || req.payload[PAYLOAD.price] !== priceText(type, pages, pricing)) {
    return { ok: false, problem: `The price shown for this ${what} does not match what it costs, so it cannot be put to a yes.` };
  }
  try {
    return { ok: true, name: name.trim(), pdf: await renderOutgoing(req, name.trim(), bytes, req.document.hash) };
  } catch {
    // The built-in fonts cover Western alphabets only. A name or purpose
    // outside them is refused rather than printed with letters changed.
    return { ok: false, problem: `Mano could not print this ${what} exactly as written, so it was not prepared.` };
  }
}

// Only the person's own yes sends anything, on every path that reaches
// the provider.
export function assertAnswered(req: ActionRequest): void {
  if (!req.answeredBy || req.answeredBy !== req.personId) {
    throw new DefiniteFailureError("Only the person it is sent for can approve this, and they have not answered.");
  }
}

// The key the provider sees: scoped to the person, and free of anything
// the caller wrote.
export async function downstreamKey(personId: string, idempotencyKey: string): Promise<string> {
  return `mano-${await sha256Hex(`${personId}:${idempotencyKey}`)}`;
}

// Runs a provider call under a deadline. A deadline that passes is a
// TimeoutError, which the gateway reconciles: the provider may still have
// acted. An answered 4xx means it did not act, except the two that only
// mean try later.
export async function providerFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new TimeoutError(`${label} timed out.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function assertAccepted(res: Response, label: string): void {
  if (res.ok) return;
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    throw new DefiniteFailureError(`${label} rejected the request: ${res.status}`);
  }
  throw new Error(`${label} failed: ${res.status}`);
}

export interface OutboundEnv {
  LOB_TEST_API_KEY?: string;
  LOB_WEBHOOK_SECRET?: string;
  TELNYX_API_KEY?: string;
  TELNYX_FAX_CONNECTION_ID?: string;
  TELNYX_PUBLIC_KEY?: string;
  MANO_OWN_FAX_NUMBER?: string;
  MANO_FAX_FROM_NUMBER?: string;
  MANO_FAX_CENTS_PER_PAGE?: string;
  MANO_MAIL_BASE_CENTS?: string;
  MANO_MAIL_CENTS_PER_EXTRA_PAGE?: string;
}
