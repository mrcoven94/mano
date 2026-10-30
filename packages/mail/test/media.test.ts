import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boxToPixels, clampBox, detectPaperBoxes, frameSharpness, iou, normalizeImage, trackBoxes } from "../src/media.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("clampBox", () => {
  it("clamps and orders coordinates", () => {
    expect(clampBox({ ymin: 900, xmin: -5, ymax: 100, xmax: 1200 })).toEqual({
      ymin: 100,
      xmin: 0,
      ymax: 900,
      xmax: 1000,
    });
  });
});

describe("boxToPixels", () => {
  it("maps 0-1000 boxes to pixels", () => {
    expect(boxToPixels({ ymin: 0, xmin: 250, ymax: 500, xmax: 750 }, 400, 200)).toEqual({
      left: 100,
      top: 0,
      w: 200,
      h: 100,
    });
  });
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint", () => {
    const a = { ymin: 0, xmin: 0, ymax: 100, xmax: 100 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { ymin: 200, xmin: 200, ymax: 300, xmax: 300 })).toBe(0);
  });
  it("is 0.25 for a quarter overlap", () => {
    const v = iou({ ymin: 0, xmin: 0, ymax: 100, xmax: 100 }, { ymin: 50, xmin: 50, ymax: 150, xmax: 150 });
    expect(v).toBeCloseTo(2500 / 17500, 5);
  });
});

describe("trackBoxes", () => {
  const det = (box: { ymin: number; xmin: number; ymax: number; xmax: number }) => ({ box });
  it("joins overlapping detections across frames", () => {
    const tracks = trackBoxes([
      [det({ ymin: 0, xmin: 0, ymax: 100, xmax: 100 })],
      [det({ ymin: 5, xmin: 5, ymax: 105, xmax: 105 })],
      [det({ ymin: 8, xmin: 8, ymax: 108, xmax: 108 })],
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toHaveLength(3);
  });
  it("starts new tracks for far-apart boxes", () => {
    const tracks = trackBoxes([
      [
        det({ ymin: 0, xmin: 0, ymax: 100, xmax: 100 }),
        det({ ymin: 500, xmin: 500, ymax: 900, xmax: 900 }),
      ],
      [det({ ymin: 5, xmin: 5, ymax: 105, xmax: 105 })],
    ]);
    expect(tracks).toHaveLength(2);
  });
  it("vetoes merges when appearance differs", () => {
    const box = { ymin: 0, xmin: 0, ymax: 100, xmax: 100 };
    const tracks = trackBoxes(
      [[{ box, tag: "a" }], [{ box, tag: "b" }]],
      0.3,
      (prev, next) => prev.tag === next.tag,
    );
    expect(tracks).toHaveLength(2);
  });
});

describe("regionHash", () => {
  async function imageWithText(lines: string[]): Promise<{ buffer: Buffer; width: number; height: number }> {
    const { default: sharp } = await import("sharp");
    const texts = lines.map((l, i) => `<text x="20" y="${60 + i * 40}" font-family="monospace" font-size="28" fill="#111">${l}</text>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/>${texts}</svg>`;
    const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
    return { buffer, width: 300, height: 200 };
  }
  it("hashes the same letter close and different letters apart", async () => {
    const { regionHash, hashDistance } = await import("../src/media.js");
    const full = { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 };
    const a = await imageWithText(["alpha bravo", "charlie delta"]);
    const b = await imageWithText(["zebra yoyo", "xray whiskey"]);
    const ha1 = await regionHash(a, full);
    const ha2 = await regionHash(a, full);
    const hb = await regionHash(b, full);
    expect(hashDistance(ha1, ha2)).toBe(0);
    expect(hashDistance(ha1, hb)).toBeGreaterThan(4);
  });
});

describe("detectPaperBoxes", () => {
  async function tablePhoto(second: boolean): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    const secondRect = second ? `<rect x="420" y="60" width="300" height="480" fill="#fffdf5"/>` : "";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="600"><rect width="780" height="600" fill="#7a7263"/>` +
      `<rect x="60" y="60" width="300" height="480" fill="#fffdf5"/>${secondRect}</svg>`;
    return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  }
  it("finds one letter", async () => {
    const frame = await normalizeImage(await tablePhoto(false), "image/jpeg");
    const boxes = await detectPaperBoxes(frame);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.box.xmin).toBeLessThan(150);
  });
  it("splits two side-by-side letters", async () => {
    const frame = await normalizeImage(await tablePhoto(true), "image/jpeg");
    const boxes = await detectPaperBoxes(frame);
    expect(boxes).toHaveLength(2);
  });
});

describe("extractVideoFrames", () => {
  it("reports truncation instead of silently stopping", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { default: sharp } = await import("sharp");
    const { extractVideoFrames, ffmpegAvailable } = await import("../src/media.js");
    if (!ffmpegAvailable()) return;
    const dir = mkdtempSync(join(tmpdir(), "mano-mail-trunc-"));
    const imgPath = join(dir, "frame.jpg");
    const vidPath = join(dir, "clip.mp4");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
      .jpeg()
      .toFile(imgPath);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-t", "3", "-i", imgPath, "-pix_fmt", "yuv420p", vidPath]);
    const bytes = new Uint8Array(readFileSync(vidPath));
    const capped = await extractVideoFrames(bytes, { fps: 1, maxFrames: 1 });
    expect(capped.frames).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    const whole = await extractVideoFrames(bytes, { fps: 1, maxFrames: 5 });
    expect(whole.frames).toHaveLength(3);
    expect(whole.truncated).toBe(false);
    await expect(extractVideoFrames(bytes, { fps: 1, maxFrames: 5, maxOutputBytes: 100 })).rejects.toThrow(
      /decode cap/,
    );
  });
});

describe("makePrivateTmpDir", () => {
  it("creates a 0o700 dir, holds 0o600 files, and cleans up", async () => {
    const { existsSync, statSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { makePrivateTmpDir, releasePrivateTmpDir } = await import("../src/media.js");
    const dir = makePrivateTmpDir();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, "clip.mp4");
    writeFileSync(file, Buffer.from([1, 2, 3]), { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    releasePrivateTmpDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("normalizeImage", () => {
  it("decodes a real HEIC photo", async () => {
    const bytes = new Uint8Array(readFileSync(join(here, "fixtures", "heic-photo.heic")));
    const image = await normalizeImage(bytes, "image/heic");
    expect(image.width).toBe(120);
    expect(image.height).toBe(80);
    expect(image.buffer.length).toBeGreaterThan(100);
  });
  it("asks a question's worth of error on corrupt HEIC bytes", async () => {
    await expect(normalizeImage(new Uint8Array([0, 1, 2, 3]), "image/heic")).rejects.toThrow();
  });
  it("caps oversized photos at 4096 on the long side", async () => {
    const { default: sharp } = await import("sharp");
    const big = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "#889" } })
      .jpeg({ quality: 80 })
      .toBuffer();
    const image = await normalizeImage(big, "image/jpeg");
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(4096);
    expect(image.width).toBe(4096);
  });
});

describe("downscaleForModel", () => {
  it("shrinks large crops to 1600 and leaves small ones alone", async () => {
    const { default: sharp } = await import("sharp");
    const { downscaleForModel } = await import("../src/media.js");
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#fff" } })
      .jpeg({ quality: 85 })
      .toBuffer();
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } })
      .jpeg({ quality: 85 })
      .toBuffer();
    const shrunk = await downscaleForModel({ buffer: big, width: 4000, height: 3000 });
    const shrunkMeta = await sharp(shrunk).metadata();
    expect(shrunkMeta.width).toBe(1600);
    const kept = await downscaleForModel({ buffer: small, width: 800, height: 600 });
    expect(kept).toBe(small);
  });
});

describe("frameSharpness", () => {
  async function textPhoto(blur: number): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#888"/><rect x="60" y="40" width="280" height="220" fill="#fff"/><text x="80" y="120" font-family="monospace" font-size="20" fill="#111">sharp text here</text><text x="80" y="160" font-family="monospace" font-size="20" fill="#111">second line here</text></svg>`;
    let img = sharp(Buffer.from(svg)).jpeg({ quality: 90 });
    if (blur > 0) img = sharp(await img.toBuffer()).blur(blur);
    return img.jpeg({ quality: 90 }).toBuffer();
  }
  it("scores a sharp photo above a blurred one", async () => {
    const sharpScore = await frameSharpness(await textPhoto(0));
    const blurScore = await frameSharpness(await textPhoto(3));
    expect(sharpScore).toBeGreaterThan(blurScore * 2);
  });
});
