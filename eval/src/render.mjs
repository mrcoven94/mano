// Render letters as text and as phone-photo style images.
// SVG is only the text source. Committed photos are real JPG pixels with
// skew, perspective shear, blur, shadows, uneven light, partial crops on
// some, a folded corner on some, and a second page for some. Rendering is
// deterministic per letterId so the pipeline runs at $0. Muse Image may be
// used for backgrounds; the default local backgrounds keep the eval runnable
// without keys.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
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
  const fold = !unreadable && rng() < 0.3;

  const svgBuffer = Buffer.from(svg);
  let png = await sharp(svgBuffer, { density: 140 }).png().toBuffer();
  // Skew plus a touch of perspective shear, like a handheld photo.
  const shearX = rng() * 0.1 - 0.05;
  const shearY = rng() * 0.06 - 0.03;
  png = await sharp(png)
    .rotate(Number(angle), { background: { r: 255, g: 253, b: 245, alpha: 1 } })
    .affine([[1, shearX], [shearY, 1]], { background: { r: 255, g: 253, b: 245, alpha: 1 } })
    .blur(sigma)
    .toBuffer();
  if (unreadable) {
    // Mosaic in two passes (chained resizes do not compose): downscale,
    // then nearest-neighbor back up. Nothing recoverable.
    const pre = await sharp(png).metadata();
    const small = await sharp(png).resize(48, null, { kernel: "lanczos3" }).png().toBuffer();
    png = await sharp(small).resize(pre.width, pre.height, { kernel: "nearest", fit: "fill" }).png().toBuffer();
  }
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
  let composed = await sharp({
    create: { width: bgW, height: bgH, channels: 3, background: tone },
  })
    .composite([
      { input: shadow, top: padY + 10, left: padX + 8 },
      { input: png, top: padY, left: padX },
    ])
    .png()
    .toBuffer();
  // Uneven light: a soft diagonal gradient, sometimes bright, sometimes dim.
  const lightDir = rng() < 0.5 ? 0 : 1;
  const lightColor = rng() < 0.6 ? "255,255,255" : "0,0,0";
  const lightStrength = (0.1 + rng() * 0.14).toFixed(2);
  const x1 = lightDir ? bgW : 0;
  const gradient = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bgW}" height="${bgH}"><defs><linearGradient id="g" x1="${x1}" y1="0" x2="${bgW - x1}" y2="${bgH}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="rgb(${lightColor})" stop-opacity="${lightStrength}"/><stop offset="1" stop-color="rgb(${lightColor})" stop-opacity="0"/></linearGradient></defs><rect width="${bgW}" height="${bgH}" fill="url(#g)"/></svg>`
  );
  composed = await sharp(composed).composite([{ input: gradient, blend: "over" }]).png().toBuffer();
  // Partial crop on some photos: a random window keeping most of the page.
  if (rng() < 0.35) {
    const keepW = 0.86 + rng() * 0.1;
    const keepH = 0.86 + rng() * 0.1;
    const w = Math.floor(bgW * keepW);
    const h = Math.floor(bgH * keepH);
    const left = Math.floor(rng() * (bgW - w));
    const top = Math.floor(rng() * (bgH - h));
    composed = await sharp(composed).extract({ left, top, width: w, height: h }).png().toBuffer();
  }
  return sharp(composed).jpeg({ quality: 82 }).toBuffer();
}

// Map letterId to its photo files in a directory. Used at run time so photo
// inputs need no manifest: any `${letterId}*.jpg` file belongs to the letter.
export async function photoFilesByLetter(photoDir) {
  const map = {};
  let files = [];
  try {
    files = await readdir(photoDir);
  } catch {
    return map;
  }
  for (const f of files.filter((x) => x.endsWith(".jpg") || x.endsWith(".jpeg") || x.endsWith(".png")).sort()) {
    const letterId = f.replace(/\.(jpg|jpeg|png)$/, "").replace(/-p\d+$/, "");
    if (!map[letterId]) map[letterId] = [];
    map[letterId].push(join(photoDir, f));
  }
  return map;
}

export async function renderPhoto(letter, householdId, { fetchImpl = fetch } = {}) {
  // Out-of-order letters photograph as received: page 2 first, then page 1.
  const outOfOrder = letter.text.includes("--- page 1 follows ---");
  const pages = letter.pageCount === 2
    ? (outOfOrder ? letter.text.split("\n\n--- page 1 follows ---\n\n") : splitForPages(letter.text))
    : [letter.text];
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

// Render the first `lettersEach` letters of each household into outDir.
// Used for committed dev photos and, with a temp dir, for run-time
// held-out photos that must never persist. Returns the file count.
export async function renderHouseholdPhotos(households, outDir, lettersEach = 2) {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = String(outDir).startsWith("file:") ? new URL(outDir).pathname : String(outDir);
  let count = 0;
  for (const h of households) {
    for (const letter of h.letters.slice(0, lettersEach)) {
      const photo = await renderPhoto(letter, h.householdId);
      for (const f of photo.files) {
        await writeFile(join(dir, f.filename), f.buffer);
        count++;
      }
    }
  }
  return count;
}

export function contentHash(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
