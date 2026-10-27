// Renders dev-set letters as phone-photo style JPEGs: SVG text source
// rasterized with sharp, then skewed, blurred, shadowed on a table
// background, with a folded corner on some. Deterministic per seed so
// fixtures regenerate identically.

import sharp from "sharp";

export interface PhotoTreatment {
  angle: number;
  blur: number;
  fold: boolean;
  shadowOffset: number;
  tone: { r: number; g: number; b: number };
}

// Small deterministic PRNG (mulberry32) from a string seed.
export function rngFromSeed(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLE_TONES = [
  { r: 139, g: 128, b: 112 },
  { r: 118, g: 115, b: 105 },
  { r: 151, g: 141, b: 126 },
  { r: 105, g: 98, b: 90 },
];

export function treatmentFor(seed: string): PhotoTreatment {
  const rng = rngFromSeed(seed);
  return {
    angle: rng() * 6 - 3,
    blur: 0.3 + rng() * 0.6,
    fold: rng() < 0.35,
    shadowOffset: 6 + Math.floor(rng() * 10),
    tone: TABLE_TONES[Math.floor(rng() * TABLE_TONES.length)]!,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapText(text: string, width = 66): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > width && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function letterSvg(pageText: string, caption: string): string {
  const lines = wrapText(pageText).slice(0, 56);
  const tspans = lines
    .map(
      (l, i) =>
        `<text x="56" y="${104 + i * 24}" font-family="Georgia, 'Times New Roman', serif" font-size="16" fill="#1c1c1c">${esc(l.slice(0, 72)) || " "}</text>`,
    )
    .join("");
  const height = 104 + lines.length * 24 + 70;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="${height}">` +
    `<rect width="780" height="${height}" fill="#fffdf5"/>${tspans}` +
    `<text x="56" y="${height - 26}" font-family="monospace" font-size="12" fill="#a0a0a0">synthetic ${esc(caption)}</text></svg>`
  );
}

async function rasterizeLetter(pageText: string, caption: string): Promise<Buffer> {
  return sharp(Buffer.from(letterSvg(pageText, caption)), { density: 150 }).png().toBuffer();
}

async function foldCorner(): Promise<Buffer> {
  const s = 80;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
      `<polygon points="0,0 ${s},0 ${s},${s}" fill="#cfc9b8"/>` +
      `<polygon points="0,0 ${s},0 0,${s}" fill="#fffdf5" opacity="0.85"/></svg>`,
  );
}

// One letter page as a phone photo on a table.
export async function renderPhoto(pageText: string, caption: string, treatment: PhotoTreatment): Promise<Buffer> {
  let page = await rasterizeLetter(pageText, caption);
  page = await sharp(page)
    .rotate(treatment.angle, { background: { r: 255, g: 253, b: 245, alpha: 1 } })
    .blur(treatment.blur)
    .toBuffer();
  const meta = await sharp(page).metadata();
  const rw = meta.width ?? 780;
  const rh = meta.height ?? 1000;
  if (treatment.fold) {
    page = await sharp(page)
      .composite([{ input: await foldCorner(), top: 8, left: rw - 88 }])
      .png()
      .toBuffer();
  }
  return tableComposite([page], treatment);
}

// Two pages overlapping on one table, like a real pile. Page A is full
// size underneath; page B is smaller and shifted so A stays partly
// visible.
export async function renderOverlap(
  pageA: { text: string; caption: string },
  pageB: { text: string; caption: string },
  treatment: PhotoTreatment,
): Promise<Buffer> {
  const big = await sharp(await rasterizeLetter(pageA.text, pageA.caption))
    .rotate(treatment.angle - 4, { background: { r: 255, g: 253, b: 245, alpha: 1 } })
    .blur(treatment.blur)
    .toBuffer();
  const bFull = await sharp(await rasterizeLetter(pageB.text, pageB.caption))
    .rotate(treatment.angle + 7, { background: { r: 255, g: 253, b: 245, alpha: 1 } })
    .blur(treatment.blur + 0.2)
    .toBuffer();
  const bMeta = await sharp(bFull).metadata();
  const small = await sharp(bFull)
    .resize(Math.round((bMeta.width ?? 780) * 0.62))
    .toBuffer();
  return tableCompositeOverlap(big, small, treatment);
}

async function tableComposite(pages: Buffer[], t: PhotoTreatment): Promise<Buffer> {
  const meta = await sharp(pages[0]!).metadata();
  const rw = meta.width ?? 780;
  const rh = meta.height ?? 1000;
  const padX = 70;
  const padY = 80;
  const shadow = await sharp({
    create: { width: rw, height: rh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.4 } },
  })
    .blur(14)
    .png()
    .toBuffer();
  return sharp({ create: { width: rw + padX * 2, height: rh + padY * 2, channels: 3, background: t.tone } })
    .composite([
      { input: shadow, top: padY + t.shadowOffset, left: padX + t.shadowOffset },
      { input: pages[0]!, top: padY, left: padX },
    ])
    .jpeg({ quality: 82 })
    .toBuffer();
}

async function tableCompositeOverlap(big: Buffer, smallPage: Buffer, t: PhotoTreatment): Promise<Buffer> {
  const bigMeta = await sharp(big).metadata();
  const smallMeta = await sharp(smallPage).metadata();
  const bw = bigMeta.width ?? 780;
  const bh = bigMeta.height ?? 1000;
  const sw = smallMeta.width ?? 400;
  const sh = smallMeta.height ?? 500;
  const pad = 90;
  const canvasW = bw + sw / 2 + pad * 2;
  const canvasH = Math.max(bh, sh + 120) + pad * 2;
  const shadowBig = await sharp({
    create: { width: bw, height: bh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.4 } },
  })
    .blur(14)
    .png()
    .toBuffer();
  const shadowSmall = await sharp({
    create: { width: sw, height: sh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.45 } },
  })
    .blur(10)
    .png()
    .toBuffer();
  const smallLeft = Math.round(pad + bw - sw * 0.45);
  const smallTop = Math.round(pad + 60);
  return sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: t.tone } })
    .composite([
      { input: shadowBig, top: pad + t.shadowOffset, left: pad + t.shadowOffset },
      { input: big, top: pad, left: pad },
      { input: shadowSmall, top: smallTop + 8, left: smallLeft + 8 },
      { input: smallPage, top: smallTop, left: smallLeft },
    ])
    .jpeg({ quality: 82 })
    .toBuffer();
}
