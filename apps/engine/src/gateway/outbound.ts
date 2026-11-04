import { createHash } from "node:crypto";
import { PDFDocument, PDFName, StandardFonts, degrees, type PDFFont, type PDFPage } from "pdf-lib";
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
// numbers. A key that already holds an approval keeps the numbers it froze
// and reads nothing, so a replay is answered whatever storage is doing.
// Anything else, or a document it cannot read, passes through unchanged
// and the executor refuses it.
export async function withOutboundPrice(
  raw: unknown,
  readDocument: (id: string) => Promise<Uint8Array | string | null>,
  pricing: OutboundPricing,
  frozenRequest: (idempotencyKey: string) => string | null,
): Promise<unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const { type, documentId, payload, idempotencyKey } = raw as { type?: unknown; documentId?: unknown; payload?: unknown; idempotencyKey?: unknown };
  if (!isOutbound(type) || typeof documentId !== "string" || typeof payload !== "object" || payload === null) return raw;
  const frozen = typeof idempotencyKey === "string" ? frozenRequest(idempotencyKey) : null;
  if (frozen) {
    const { payload: held } = JSON.parse(frozen) as { payload: Record<string, unknown> };
    return { ...raw, payload: { ...payload, [PAYLOAD.pages]: held[PAYLOAD.pages], [PAYLOAD.price]: held[PAYLOAD.price] } };
  }
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

// The one rule for a PDF: it goes out only if it is plain. Anything a viewer
// can show differently from what is sent (a form field, a layer, a note, a
// link, a crop, a rotation, a page away from the origin) means the person may
// approve one thing and something else goes out, so it is refused before the
// question and they are asked for a photo instead. What is left is drawn by
// its page content alone, which is what embedding carries over. Completed
// forms come back when there is a renderer to compare the result against.
const NOT_PLAIN =
  "Mano only sends plain PDFs, and this one has parts that could go out looking different from what you saw, so it was not prepared. Send a photo of it instead.";
const SAME_BOX_POINTS = 0.5;

async function isPlainPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
    if (doc.catalog.has(PDFName.of("OCProperties"))) return false;
    const form = doc.catalog.getAcroForm();
    if (form && (form.dict.has(PDFName.of("XFA")) || form.getAllFields().length > 0)) return false;
    return doc.getPages().every((page) => {
      const [crop, media] = [page.getCropBox(), page.getMediaBox()];
      return (
        page.getRotation().angle % 360 === 0 &&
        Math.abs(media.x) <= SAME_BOX_POINTS &&
        Math.abs(media.y) <= SAME_BOX_POINTS &&
        (["x", "y", "width", "height"] as const).every((side) => Math.abs(crop[side] - media[side]) <= SAME_BOX_POINTS) &&
        (page.node.Annots()?.size() ?? 0) === 0
      );
    });
  } catch {
    return false;
  }
}

// How far to turn a photo so it reads the way a viewer shows it, by its
// EXIF Orientation. The other values are mirrored, which is refused.
const TURNS: Partial<Record<number, 0 | 180 | -90 | 90>> = { 1: 0, 3: 180, 6: -90, 8: 90 };

// A JPEG's EXIF Orientation, or 1 when it has none or it cannot be read,
// which is how a viewer treats it too.
function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    for (let at = 2; bytes[at] === 0xff && bytes[at + 1] !== 0xda; at += 2 + view.getUint16(at + 2)) {
      if (bytes[at + 1] !== 0xe1 || String.fromCharCode(...bytes.subarray(at + 4, at + 10)) !== "Exif\0\0") continue;
      const tiff = at + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const entries = tiff + view.getUint32(tiff + 4, little);
      for (let i = 0; i < view.getUint16(entries, little); i++) {
        const entry = entries + 2 + i * 12;
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
      }
      return 1;
    }
  } catch {
    // Ran off the end of a malformed file.
  }
  return 1;
}

// The cover page, then each page of the document fitted to US Letter,
// which both providers accept. The same request always renders the same
// bytes, so a retry sends what the first try sent.
async function renderOutgoing(req: ActionRequest, name: string, bytes: Uint8Array, documentHash: string): Promise<Uint8Array<ArrayBuffer>> {
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
    const turn = TURNS[kind === "jpg" ? jpegOrientation(bytes) : 1];
    if (turn === undefined) throw new Error("mirrored photo");
    const sideways = turn === 90 || turn === -90;
    const shown = sideways ? { width: image.height, height: image.width } : { width: image.width, height: image.height };
    const { x, y, xScale: scale } = fitted(shown);
    const [right, top] = [x + shown.width * scale, y + shown.height * scale];
    // pdf-lib turns an image about its lower left corner, so that corner
    // starts wherever the turn leaves it.
    const corner = { "0": { x, y }, "180": { x: right, y: top }, "-90": { x, y: top }, "90": { x: right, y } }[turn];
    out.addPage([LETTER.width, LETTER.height]).drawImage(image, { ...corner, width: image.width * scale, height: image.height * scale, rotate: degrees(turn) });
  }
  const fixed = new Date(0);
  out.setCreationDate(fixed);
  out.setModificationDate(fixed);
  out.setProducer("Mano");
  out.setCreator("Mano");
  return (await out.save()).slice();
}

// All a fax or letter may carry beside its document. The question prints
// every payload field, so one that does not go out must not be there: what
// the person approves is what is sent. The attachment label only names the
// document that goes.
const PAYLOAD_FIELDS: Record<OutboundType, ReadonlySet<string>> = {
  fax: new Set([PAYLOAD.faxTo, PAYLOAD.approvedBy, PAYLOAD.pages, PAYLOAD.price, "attachment"]),
  mail: new Set([PAYLOAD.mailTo, PAYLOAD.returnAddress, PAYLOAD.approvedBy, PAYLOAD.pages, PAYLOAD.price, "attachment"]),
};

export type Outgoing = { ok: true; name: string; pdf: Uint8Array<ArrayBuffer> } | { ok: false; problem: string };

// Everything a fax and a letter must have, checked before the question
// and again right before sending: a document, a name for the attestation,
// and the pages and price Engine works out for these exact bytes.
export async function prepareOutgoing(req: ActionRequest, type: OutboundType, pricing: OutboundPricing): Promise<Outgoing> {
  const what = type === "fax" ? "fax" : "letter";
  if (!req.document) return { ok: false, problem: `A ${what} needs a document to send.` };
  if (Object.keys(req.payload).some((field) => !PAYLOAD_FIELDS[type].has(field))) {
    return { ok: false, problem: `A ${what} can only carry the document itself, so Mano did not prepare anything written beside it.` };
  }
  const bytes = base64ToBytes(req.document.bytesB64);
  if (kindOf(bytes) === "pdf" && !(await isPlainPdf(bytes))) return { ok: false, problem: NOT_PLAIN };
  const name = req.payload[PAYLOAD.approvedBy];
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, problem: `A ${what} needs the name of the person approving it, to print on it.` };
  }
  const pages = await outgoingPages(type, bytes);
  if (pages === null) return { ok: false, problem: `Mano can only send a PDF, PNG or JPG it can open, and it could not open this document.` };
  if (pages > MAX_PAGES[type]) return { ok: false, problem: `This ${what} would be ${pages} pages, and Mano can send at most ${MAX_PAGES[type]}.` };
  if (req.payload[PAYLOAD.pages] !== pages || req.payload[PAYLOAD.price] !== priceText(type, pages, pricing)) {
    return { ok: false, problem: `The price shown for this ${what} does not match what it costs, so it cannot be put to a yes.` };
  }
  try {
    return { ok: true, name: name.trim(), pdf: await renderOutgoing(req, name.trim(), bytes, req.document.hash) };
  } catch {
    // The built-in fonts cover Western alphabets only, and a mirrored photo
    // cannot be shown as it is stored. Either is refused rather than sent changed.
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

// Names the provider and the account an attempt begins against, without
// the key: a truncated hash of it. A lookup under another account finds
// nothing, which must never read as "never sent".
export function providerIdentity(provider: string, apiKey: string): string {
  return `${provider}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

// The key the provider sees: scoped to the person, and free of anything
// the caller wrote.
export async function downstreamKey(personId: string, idempotencyKey: string): Promise<string> {
  return `mano-${await sha256Hex(`${personId}:${idempotencyKey}`)}`;
}

// A provider's answer, read in full under the deadline.
export interface ProviderResponse {
  ok: boolean;
  status: number;
  text: string;
}

// Runs a provider call under a deadline that covers the body too: an answer
// that stalls after its headers is still a timeout. A deadline that passes
// is a TimeoutError, which the gateway reconciles: the provider may still
// have acted. An answered 4xx means it did not act, except the two that only
// mean try later.
export async function providerFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new TimeoutError(`${label} timed out.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function assertAccepted(res: ProviderResponse, label: string): void {
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
