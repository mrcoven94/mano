// Synthetic pictures for the bench. Every image is generated markup with a
// TEST banner, never a real scan or photo. The stand-in mail reader returns
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

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function syntheticLetter(id: string, lines: string[], transcript: string): LetterImage {
  return { id, svg: svgDoc(lines, "SYNTHETIC TEST LETTER"), transcript };
}

export function syntheticPhoto(id: string, caption: string, transcript: string): LetterImage {
  return { id, svg: svgDoc([caption], "SYNTHETIC TEST PHOTO"), transcript };
}
