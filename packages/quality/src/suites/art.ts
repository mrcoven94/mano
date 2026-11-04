// Synthetic pictures for the bench. Every image is generated markup marked
// as a TEST letter or photo, never a real scan or photo. The stand-in mail reader returns
// the transcript; the real path transcribes the SVG through packages/mail.

import type { LetterImage } from "./types.ts";

function svgDoc(lines: string[], banner: string): string {
  const body = lines.map((l, i) => `<text x="40" y="${120 + i * 34}">${escapeXml(l)}</text>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800" role="img">` +
    `<rect width="640" height="800" fill="#ffffff"/>` +
    `<rect width="640" height="64" fill="#1d4ed8"/>` +
    `<text x="40" y="42" fill="#ffffff" font-size="24">${escapeXml(banner)}</text>${body}</svg>`
  );
}

const AMPERSAND_RE = /&/g;
const LESS_THAN_RE = /</g;
const GREATER_THAN_RE = />/g;

function escapeXml(s: string): string {
  return s.replace(AMPERSAND_RE, "&amp;").replace(LESS_THAN_RE, "&lt;").replace(GREATER_THAN_RE, "&gt;");
}

export function syntheticLetter(id: string, lines: string[], transcript: string): LetterImage {
  return { id, svg: svgDoc(lines, "SYNTHETIC TEST LETTER"), transcript };
}

export function syntheticPhoto(id: string, caption: string, transcript: string): LetterImage {
  return { id, svg: svgDoc([caption], "SYNTHETIC TEST PHOTO"), transcript };
}

// A one-page notice, drawn the way an office prints one. The same structure
// gives the picture and its transcript, so the two never disagree.
export type LetterBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "box"; text: string }
  | { kind: "table"; rows: [string, string][] };

export interface LetterPage {
  look: "office" | "scam";
  // The sender's name, then its address lines.
  letterhead: string[];
  // When the letter was printed, alone on its line under the letterhead.
  date?: string;
  recipient: string[];
  caseNumber?: string;
  subject: string;
  greeting: string;
  blocks: LetterBlock[];
  signoff: string[];
  contact: string;
  // Gray print under the footer rule, as a planted line would sit.
  smallPrint?: string;
}

const PAGE_W = 850;
const PAGE_H = 1100;
const MARGIN = 72;
const FOOTER_Y = 1020;
const WRAP_CHARS = 86;
const FONT = "Helvetica, Arial, 'DejaVu Sans', sans-serif";
export const LETTER_FOOTER = "SYNTHETIC TEST LETTER. Every name, office, number and address on this page is made up.";

// A written date never breaks across lines: its spaces become no-break spaces.
const SPACES_RE = / +/;
const WHITESPACE_RE = /\s+/;
const DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/g;

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(DATE_RE, "$1\u00a0$2,\u00a0$3").split(SPACES_RE)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textAt(x: number, y: number, s: string, attrs = ""): string {
  return `<text x="${x}" y="${y}"${attrs ? ` ${attrs}` : ""}>${escapeXml(s)}</text>`;
}

function pageTranscript(p: LetterPage): string {
  const blocks = p.blocks.map((b) =>
    b.kind === "list" ? b.items.map((i) => `- ${i}`).join("\n")
    : b.kind === "table" ? b.rows.map(([label, value]) => `${label}: ${value}`).join("\n")
    : b.text);
  return [
    p.letterhead.join("\n"),
    ...(p.date ? [p.date] : []),
    p.recipient.join("\n"),
    ...(p.caseNumber ? [`Case number: ${p.caseNumber}`] : []),
    p.subject,
    p.greeting,
    ...blocks,
    p.signoff.join("\n"),
    p.contact,
    LETTER_FOOTER,
    ...(p.smallPrint ? [p.smallPrint] : []),
  ].join("\n\n");
}

function pageSvg(p: LetterPage): string {
  const scam = p.look === "scam";
  const ink = scam ? "#b91c1c" : "#1e3a5f";
  const out: string[] = [];
  let y: number;
  if (scam) {
    out.push(`<rect x="${MARGIN}" y="48" width="${PAGE_W - 2 * MARGIN}" height="64" fill="${ink}"/>`);
    out.push(textAt(PAGE_W / 2, 92, p.letterhead[0]!, `fill="#ffffff" font-size="30" font-weight="bold" text-anchor="middle"`));
    y = 150;
    for (const l of p.letterhead.slice(1)) {
      out.push(textAt(MARGIN, y, l, `font-size="14" fill="#444444"`));
      y += 20;
    }
    y += 20;
  } else {
    const initials = p.letterhead[0]!.split(WHITESPACE_RE).slice(0, 2).map((w) => w[0]).join("");
    out.push(`<circle cx="${MARGIN + 30}" cy="86" r="32" fill="none" stroke="${ink}" stroke-width="3"/>`);
    out.push(textAt(MARGIN + 30, 94, initials, `font-size="22" font-weight="bold" fill="${ink}" text-anchor="middle"`));
    out.push(textAt(MARGIN + 80, 76, p.letterhead[0]!, `font-size="22" font-weight="bold" fill="${ink}"`));
    p.letterhead.slice(1).forEach((l, i) => out.push(textAt(MARGIN + 80, 100 + i * 19, l, `font-size="14" fill="#444444"`)));
    out.push(`<rect x="${MARGIN}" y="140" width="${PAGE_W - 2 * MARGIN}" height="2" fill="${ink}"/>`);
    y = 182;
  }
  if (p.date) {
    out.push(textAt(MARGIN, y, p.date, `font-size="15"`));
    y += 40;
  }
  const top = y;
  p.recipient.forEach((l, i) => out.push(textAt(MARGIN, top + i * 21, l, `font-size="15"`)));
  if (p.caseNumber) out.push(textAt(PAGE_W - MARGIN, top, `Case number: ${p.caseNumber}`, `font-size="15" font-weight="bold" text-anchor="end"`));
  y = top + p.recipient.length * 21 + 28;
  for (const l of wrap(p.subject, 70)) {
    out.push(textAt(MARGIN, y, l, `font-size="17" font-weight="bold"${scam ? ` fill="${ink}"` : ""}`));
    y += 24;
  }
  y += 14;
  out.push(textAt(MARGIN, y, p.greeting, `font-size="15"`));
  y += 32;
  for (const b of p.blocks) {
    if (b.kind === "paragraph") {
      for (const l of wrap(b.text, WRAP_CHARS)) {
        out.push(textAt(MARGIN, y, l, `font-size="15"`));
        y += 22;
      }
    } else if (b.kind === "list") {
      for (const item of b.items) {
        out.push(`<circle cx="${MARGIN + 14}" cy="${y - 5}" r="3" fill="#111111"/>`);
        out.push(textAt(MARGIN + 28, y, item, `font-size="15"`));
        y += 22;
      }
    } else if (b.kind === "table") {
      const h = 32;
      y += 6;
      out.push(`<rect x="${MARGIN}" y="${y - 22}" width="${PAGE_W - 2 * MARGIN}" height="${b.rows.length * h}" fill="none" stroke="#999999"/>`);
      b.rows.forEach(([label, value], i) => {
        const top = y - 22 + i * h;
        if (i > 0) out.push(`<rect x="${MARGIN}" y="${top}" width="${PAGE_W - 2 * MARGIN}" height="1" fill="#999999"/>`);
        out.push(`<rect x="${MARGIN}" y="${top}" width="240" height="${h}" fill="#f3f4f6"/>`);
        out.push(textAt(MARGIN + 12, top + 21, label, `font-size="15" font-weight="bold"`));
        out.push(textAt(MARGIN + 256, top + 21, value, `font-size="15"`));
      });
      y += b.rows.length * h + 4;
    } else {
      const lines = wrap(b.text, WRAP_CHARS - 6);
      out.push(`<rect x="${MARGIN}" y="${y - 22}" width="${PAGE_W - 2 * MARGIN}" height="${lines.length * 22 + 18}" fill="#f3f4f6" stroke="${ink}" stroke-width="2"/>`);
      for (const l of lines) {
        out.push(textAt(MARGIN + 16, y, l, `font-size="15" font-weight="bold"`));
        y += 22;
      }
      y += 18;
    }
    y += 12;
  }
  y += 8;
  for (const l of p.signoff) {
    out.push(textAt(MARGIN, y, l, `font-size="15"`));
    y += 21;
  }
  y += 18;
  for (const l of wrap(p.contact, WRAP_CHARS)) {
    out.push(textAt(MARGIN, y, l, `font-size="15"`));
    y += 22;
  }
  if (y > FOOTER_Y - 10) throw new Error(`letter "${p.subject}" runs past its page (${y}px)`);
  out.push(`<rect x="${MARGIN}" y="${FOOTER_Y}" width="${PAGE_W - 2 * MARGIN}" height="1" fill="#999999"/>`);
  out.push(textAt(MARGIN, FOOTER_Y + 24, LETTER_FOOTER, `font-size="12" fill="#555555"`));
  if (p.smallPrint) {
    wrap(p.smallPrint, 100).forEach((l, i) => out.push(textAt(MARGIN, FOOTER_Y + 46 + i * 16, l, `font-size="12" fill="#777777"`)));
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" role="img">` +
    `<rect width="${PAGE_W}" height="${PAGE_H}" fill="#ffffff"/>` +
    `<g font-family="${FONT}" fill="#111111">${out.join("")}</g></svg>`
  );
}

export function letterImage(id: string, page: LetterPage): LetterImage {
  return { id, svg: pageSvg(page), transcript: pageTranscript(page) };
}
