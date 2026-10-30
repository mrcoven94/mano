// Citation verification. A field is published only with a real,
// non-degenerate box, and its text must appear in that page's own
// transcription by code check. Anything else is dropped and becomes a
// question for the person. The full page is never substituted as a
// citation: a missing box means no citation.

import type { Box } from "./types.js";

export interface VerifiableField {
  text: string | null;
  box: Box | null;
}

// Boxes live in 0-1000 units. Anything under 4 units a side is a dot,
// not a citation for text.
export function isRealBox(box: Box | null): boolean {
  if (!box) return false;
  const { ymin, xmin, ymax, xmax } = box;
  if (![ymin, xmin, ymax, xmax].every((n) => Number.isFinite(n))) return false;
  return xmax - xmin >= 4 && ymax - ymin >= 4;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripPunctuation(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The field text must appear in the page transcription. Matching
// ignores case and whitespace, with a punctuation-stripped fallback so
// "(555) 100-2000" matches "5551002000" and back.
export function textInTranscription(text: string | null, fullText: string): boolean {
  if (!text || normalize(text).length < 2) return false;
  const want = normalize(text);
  const hay = normalize(fullText);
  if (want.length > 0 && hay.includes(want)) return true;
  const wantStripped = stripPunctuation(text);
  if (wantStripped.length < 2) return false;
  return stripPunctuation(fullText).includes(wantStripped);
}

export function verifyField(field: VerifiableField, fullText: string): boolean {
  if (!field.text || !field.text.trim()) return false;
  return isRealBox(field.box) && textInTranscription(field.text, fullText);
}

export interface DroppedField {
  name: string;
  value: string;
  // The claimed box when it was real; dropped contacts still become
  // warnings, cited when a box exists.
  box: Box | null;
}

// Checks every field of an extraction against the transcription,
// dropping what cannot be verified. Null fields were absent, not
// dropped, so they produce no question. The page marker is verified
// silently: it steers grouping but is never published.
export function verifyExtraction(
  ex: {
    sender: VerifiableField;
    program: VerifiableField;
    subject: VerifiableField;
    asked: VerifiableField[];
    deadlines: VerifiableField[];
    consequence: VerifiableField;
    referenceNo: VerifiableField;
    noticeDate: VerifiableField;
    phones: VerifiableField[];
    links: VerifiableField[];
    addresses: VerifiableField[];
    pageMarker: VerifiableField;
  },
  fullText: string,
): DroppedField[] {
  const dropped: DroppedField[] = [];
  const dropBox = (field: VerifiableField): Box | null => (isRealBox(field.box) ? field.box : null);
  const checkScalar = (name: string, field: VerifiableField): void => {
    if (field.text && field.text.trim() && !verifyField(field, fullText)) {
      dropped.push({ name, value: field.text.trim().slice(0, 120), box: dropBox(field) });
      field.text = null;
      field.box = null;
    }
  };
  const checkList = (name: string, fields: VerifiableField[]): VerifiableField[] => {
    const kept: VerifiableField[] = [];
    for (const field of fields) {
      if (field.text && field.text.trim() && !verifyField(field, fullText)) {
        dropped.push({ name, value: field.text.trim().slice(0, 120), box: dropBox(field) });
      } else {
        kept.push(field);
      }
    }
    return kept;
  };
  checkScalar("sender", ex.sender);
  checkScalar("program", ex.program);
  checkScalar("subject", ex.subject);
  ex.deadlines = checkList("deadline", ex.deadlines);
  checkScalar("consequence", ex.consequence);
  checkScalar("reference number", ex.referenceNo);
  checkScalar("notice date", ex.noticeDate);
  ex.asked = checkList("requested item", ex.asked);
  ex.phones = checkList("phone number", ex.phones);
  ex.links = checkList("link", ex.links);
  ex.addresses = checkList("address", ex.addresses);
  if (ex.pageMarker.text && ex.pageMarker.text.trim() && !verifyField(ex.pageMarker, fullText)) {
    ex.pageMarker.text = null;
    ex.pageMarker.box = null;
  }
  return dropped;
}
