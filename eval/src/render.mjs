// Render letters as text and as phone-photo style PNG images.
// SVG is only the text source. Committed photos are real PNG pixels with
// skew, blur, shadows, a folded corner on some, and a second page for some.
// Rendering is deterministic per letterId so the pipeline runs at $0.
// Muse Image may be used for backgrounds; the default local backgrounds
// keep the eval runnable without keys.
import { createHash } from "node:crypto";
import { PHOTO_HOUSEHOLDS } from "./generator.mjs";
import { rngFromString, intBetween } from "./rng.mjs";

export function renderText(letter) {
  return letter.text;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrap(text, width = 72) {
  const out = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + " " + word).trim().length > width) {
        out.push(line.trim());
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// SVG source for one page of text. Never committed as a photo; rendered to
// PNG with photographic effects below.
export function renderPhotoSvg(letter, householdId, pageText = null) {
  const text = pageText ?? letter.text;
  const lines = wrap(text, 68).slice(0, 52);
  const tspans = lines
    .map((l, i) => `<text x="48" y="${96 + i * 22}" font-family="Georgia, serif" font-size="15" fill="#1a1a1a">${esc(l.slice(0, 75)) || " "}</text>`)
    .join("");
  const height = 96 + lines.length * 22 + 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}"><rect width="760" height="${height}" fill="#fffdf5"/>${tspans}<text x="48" y="${height - 24}" font-family="monospace" font-size="11" fill="#999">synthetic ${householdId} ${letter.letterId}</text></svg>`;
}

function splitForPages(text) {
  const paras = text.split("\n\n");
  if (paras.length < 4) return [text];
  const mid = Math.ceil(paras.length / 2);
  return [paras.slice(0, mid).join("\n\n"), paras.slice(mid).join("\n\n")];
}

// Render one page SVG to PNG pixels with phone-photo effects.
export async function renderPagePng(svg, seedStr, { unreadable = false } = {}) {
  const sharp = (await import("sharp")).default;
  const rng = rngFromString(seedStr);
  const angle = (rng() * 4 - 2).toFixed(2);
  const sigma = unreadable ? 1.8 + rng() : 0.3 + rng() * 0.5;
  const fold = rng() < 0.3;

  const svgBuffer = Buffer.from(svg);
  let png = await sharp(svgBuffer, { density: 140 }).png().toBuffer();
  png = await sharp(png).rotate(Number(angle), { background: { r: 255, g: 253, b: 245, alpha: 1 } }).blur(sigma).toBuffer();
  const rotMeta = await sharp(png).metadata();
  const rw = rotMeta.width || 760;
  const rh = rotMeta.height || 1000;

  // Folded corner: light triangle at top-right with a soft edge.
  if (fold) {
    const s = 70;
    const corner = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><polygon points="0,0 ${s},0 ${s},${s}" fill="#d9d4c4"/><polygon points="0,0 ${s},0 0,${s}" fill="#fffdf5" opacity="0.9"/></svg>`
    );
    png = await sharp(png).composite([{ input: corner, top: 6, left: rw - s - 6 }]).png().toBuffer();
  }

  // Table background with drop shadow.
  const padX = 60;
  const padY = 70;
  const bgW = rw + padX * 2;
  const bgH = rh + padY * 2;
  const tableTones = [
    { r: 138, g: 129, b: 114 },
    { r: 122, g: 118, b: 108 },
    { r: 150, g: 140, b: 125 },
  ];
  const tone = tableTones[intBetween(rng, 0, tableTones.length - 1)];
  const shadow = await sharp({
    create: { width: rw, height: rh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.45 } },
  })
    .blur(12)
    .png()
    .toBuffer();
  const out = await sharp({
    create: { width: bgW, height: bgH, channels: 3, background: tone },
  })
    .composite([
      { input: shadow, top: padY + 10, left: padX + 8 },
      { input: png, top: padY, left: padX },
    ])
    .jpeg({ quality: 82 })
    .toBuffer();
  return out;
}

export async function renderPhoto(letter, householdId, { fetchImpl = fetch } = {}) {
  const pages = letter.pageCount === 2 ? splitForPages(letter.text) : [letter.text];
  const unreadable = letter.hardCase === "unreadable";
  const files = [];
  for (let i = 0; i < pages.length; i++) {
    const svg = renderPhotoSvg(letter, householdId, pages[i]);
    const png = await renderPagePng(svg, `${letter.letterId}:p${i + 1}`, { unreadable });
    const suffix = pages.length > 1 ? `-p${i + 1}` : "";
    files.push({ filename: `${letter.letterId}${suffix}.jpg`, buffer: png, svg });
  }
  return { kind: "photo-jpg", householdId, letterId: letter.letterId, files };
}

export function photoHouseholdIds(households) {
  return new Set(households.slice(0, PHOTO_HOUSEHOLDS).map((h) => h.householdId));
}

export function contentHash(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
