// Media handling: photo decode (JPEG, PNG, WebP, HEIC), video frame
// extraction (ffmpeg), sharpness scoring, page crop and straightening,
// and box geometry for tracking detections across frames.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Box } from "./types.js";

// Private scratch space for resident media: a 0o700 directory holding
// 0o600 files, removed on release and again on process exit so a crash
// cannot leave a readable copy behind.
const liveTmpDirs = new Set<string>();
let exitHookArmed = false;

export function makePrivateTmpDir(prefix = "mano-mail-"): string {
  if (!exitHookArmed) {
    exitHookArmed = true;
    process.once("exit", () => {
      for (const dir of liveTmpDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Last resort; nothing left to do.
        }
      }
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  liveTmpDirs.add(dir);
  return dir;
}

export function releasePrivateTmpDir(dir: string): void {
  liveTmpDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

export type MediaErrorCode =
  | "unsupported_type"
  | "image_decode_failed"
  | "heic_decode_failed"
  | "ffmpeg_missing"
  | "video_decode_failed";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HEIC_MIMES = new Set(["image/heic", "image/heif"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/mpeg"]);

export function mediaKind(mimeType: string): "image" | "heic" | "video" | "other" {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (IMAGE_MIMES.has(base)) return "image";
  if (HEIC_MIMES.has(base)) return "heic";
  if (VIDEO_MIMES.has(base)) return "video";
  return "other";
}

// Decoded-size caps. Phone photos keep their detail: 48MP panoramas do
// not need to ride through segmentation and reading at full size, and
// model input stays small enough to bound tokens. Citation boxes are
// 0-1000 relative, so downscaling never moves them.
export const MAX_PHOTO_SIDE = 4096;
export const MAX_MODEL_SIDE = 1600;
export const MAX_FFMPEG_BYTES = 256 * 1024 * 1024;

export interface NormalizedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

async function sharpOf(buffer: Buffer): Promise<import("sharp").Sharp> {
  const { default: sharp } = await import("sharp");
  return sharp(buffer);
}

// Decode a photo to a normalized JPEG buffer with dimensions. Applies
// EXIF orientation so pixels are upright.
export async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<NormalizedImage> {
  const kind = mediaKind(mimeType);
  if (kind === "image") {
    try {
      const img = await sharpOf(Buffer.from(bytes));
      const meta = await img.metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      let pipeline = img.rotate();
      if (Math.max(w, h) > MAX_PHOTO_SIDE) {
        pipeline = pipeline.resize(MAX_PHOTO_SIDE, MAX_PHOTO_SIDE, { fit: "inside", withoutEnlargement: true });
      }
      const out = await pipeline.jpeg({ quality: 90 }).toBuffer();
      const outMeta = await (await sharpOf(out)).metadata();
      return { buffer: out, width: outMeta.width ?? 0, height: outMeta.height ?? 0 };
    } catch (err) {
      throw new MediaError("image_decode_failed", `Could not decode image: ${errMessage(err)}`);
    }
  }
  if (kind === "heic") {
    return decodeHeic(bytes);
  }
  throw new MediaError("unsupported_type", `Unsupported media type: ${mimeType}`);
}

async function decodeHeic(bytes: Uint8Array): Promise<NormalizedImage> {
  let decoded: { width: number; height: number; data: Uint8ClampedArray };
  try {
    const { default: decode } = await import("heic-decode");
    decoded = await decode({ buffer: Buffer.from(bytes) });
  } catch (err) {
    throw new MediaError("heic_decode_failed", `Could not decode HEIC photo: ${errMessage(err)}`);
  }
  try {
    const { default: sharp } = await import("sharp");
    let pipeline = sharp(Buffer.from(decoded.data), {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    });
    if (Math.max(decoded.width, decoded.height) > MAX_PHOTO_SIDE) {
      pipeline = pipeline.resize(MAX_PHOTO_SIDE, MAX_PHOTO_SIDE, { fit: "inside", withoutEnlargement: true });
    }
    const out = await pipeline.jpeg({ quality: 90 }).toBuffer();
    const meta = await sharp(out).metadata();
    return { buffer: out, width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch (err) {
    throw new MediaError("heic_decode_failed", `Could not convert HEIC photo: ${errMessage(err)}`);
  }
}

let ffmpegChecked: boolean | null = null;

export function ffmpegAvailable(): boolean {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 });
    ffmpegChecked = res.status === 0;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

// Extract frames from a short video of a mail pile. Returns JPEG buffers
// at roughly fps frames per second, capped at maxFrames. Asks ffmpeg
// for one frame past the cap so truncation is detected, never silent.
export async function extractVideoFrames(
  bytes: Uint8Array,
  opts: { fps?: number; maxFrames?: number; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ frames: Buffer[]; truncated: boolean }> {
  const { fps = 1, maxFrames = 30, timeoutMs = 60000, maxOutputBytes = MAX_FFMPEG_BYTES } = opts;
  if (!ffmpegAvailable()) {
    throw new MediaError("ffmpeg_missing", "Video needs ffmpeg, which is not installed.");
  }
  // Via a temp file, not a pipe: phone MP4s often store the moov atom
  // at the end, which ffmpeg cannot seek to on stdin.
  const dir = makePrivateTmpDir();
  const tmp = join(dir, "clip.mp4");
  writeFileSync(tmp, Buffer.from(bytes), { mode: 0o600 });
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      tmp,
      "-vf",
      `fps=${fps}`,
      "-frames:v",
      String(maxFrames + 1),
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let tooLarge = false;
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > maxOutputBytes) {
        tooLarge = true;
        child.kill("SIGKILL");
      } else {
        chunks.push(d);
      }
    });
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new MediaError("video_decode_failed", "Video decoding timed out."));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new MediaError("video_decode_failed", `Video decoding failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (tooLarge) {
          reject(new MediaError("video_decode_failed", "Video frames exceed the 256 MB decode cap."));
        } else if (code !== 0) {
          const detail = Buffer.concat(errChunks).toString("utf8").slice(0, 200);
          reject(new MediaError("video_decode_failed", `Video decoding failed (exit ${code}): ${detail}`));
        } else {
          resolve();
        }
      });
    });
    const all = splitMjpeg(Buffer.concat(chunks));
    if (all.length === 0) throw new MediaError("video_decode_failed", "No frames came out of the video.");
    const truncated = all.length > maxFrames;
    return { frames: all.slice(0, maxFrames), truncated };
  } finally {
    try {
      releasePrivateTmpDir(dir);
    } catch {
      // Best effort cleanup.
    }
  }
}

function splitMjpeg(stream: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 1 < stream.length; i++) {
    if (stream[i] === 0xff && stream[i + 1] === 0xd8) start = i;
    else if (stream[i] === 0xff && stream[i + 1] === 0xd9 && start >= 0) {
      frames.push(stream.subarray(start, i + 2));
      start = -1;
    }
  }
  return frames;
}

// Sharpness as the variance of the Laplacian over a small grayscale
// copy. Higher is sharper. Used to keep the best frame per track.
export async function frameSharpness(jpeg: Buffer): Promise<number> {
  const img = await sharpOf(jpeg);
  const W = 160;
  const meta = await img.metadata();
  const aspect = (meta.height ?? 1) / (meta.width ?? 1);
  const H = Math.max(1, Math.round(W * aspect));
  const raw = await img.resize(W, H, { fit: "fill" }).grayscale().raw().toBuffer();
  const px = (x: number, y: number): number => raw[y * W + x]!;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const lap = 4 * px(x, y) - px(x - 1, y) - px(x + 1, y) - px(x, y - 1) - px(x, y + 1);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function boxToPixels(box: Box, width: number, height: number): { left: number; top: number; w: number; h: number } {
  const left = Math.max(0, Math.min(width - 1, Math.floor((box.xmin / 1000) * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor((box.ymin / 1000) * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil((box.xmax / 1000) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil((box.ymax / 1000) * height)));
  return { left, top, w: right - left, h: bottom - top };
}

export function clampBox(box: Box): Box {
  const clamp = (v: number): number => Math.max(0, Math.min(1000, Math.round(v)));
  const ymin = clamp(Math.min(box.ymin, box.ymax));
  const ymax = clamp(Math.max(box.ymin, box.ymax));
  const xmin = clamp(Math.min(box.xmin, box.xmax));
  const xmax = clamp(Math.max(box.xmin, box.xmax));
  return { ymin, xmin, ymax, xmax };
}

// Intersection over union in 0-1000 box space.
export function iou(a: Box, b: Box): number {
  const ixmin = Math.max(a.xmin, b.xmin);
  const iymin = Math.max(a.ymin, b.ymin);
  const ixmax = Math.min(a.xmax, b.xmax);
  const iymax = Math.min(a.ymax, b.ymax);
  const inter = Math.max(0, ixmax - ixmin) * Math.max(0, iymax - iymin);
  if (inter === 0) return 0;
  const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
  const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
  return inter / (areaA + areaB - inter);
}

export interface CropResult extends NormalizedImage {
  // In-plane rotation corrected, in degrees. Keystone (perspective)
  // correction is future work: it needs quad output from segmentation.
  deskewDegrees: number;
}

// Crop a detected page with a small margin, then straighten in-plane
// rotation estimated from the paper mask.
export async function cropAndStraighten(image: NormalizedImage, box: Box): Promise<CropResult> {
  const { buffer, width, height } = image;
  const padded = padBox(box, 12);
  const { left, top, w, h } = boxToPixels(padded, width, height);
  const img = await sharpOf(buffer);
  const cropped = await img.extract({ left, top, width: w, height: h }).jpeg({ quality: 92 }).toBuffer();
  const angle = await estimateSkew(cropped);
  if (Math.abs(angle) < 0.3 || Math.abs(angle) > 25) {
    const meta = await (await sharpOf(cropped)).metadata();
    return { buffer: cropped, width: meta.width ?? w, height: meta.height ?? h, deskewDegrees: 0 };
  }
  const straight = await (await sharpOf(cropped))
    .rotate(-angle, { background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 92 })
    .toBuffer();
  const meta = await (await sharpOf(straight)).metadata();
  return { buffer: straight, width: meta.width ?? w, height: meta.height ?? h, deskewDegrees: angle };
}

function padBox(box: Box, pad: number): Box {
  return clampBox({ ymin: box.ymin - pad, xmin: box.xmin - pad, ymax: box.ymax + pad, xmax: box.xmax + pad });
}

// Estimate in-plane skew from the bright paper mask: the major axis of
// a portrait page should be vertical, so its tilt is the skew. Returns
// degrees, positive clockwise. Returns 0 when no table edge is visible
// (close-ups) or the mask is too small to trust.
async function estimateSkew(cropJpeg: Buffer): Promise<number> {
  const W = 200;
  const img = await sharpOf(cropJpeg);
  const meta = await img.metadata();
  const aspect = (meta.height ?? 1) / (meta.width ?? 1);
  const H = Math.max(1, Math.round(W * aspect));
  const raw = await img.resize(W, H, { fit: "fill" }).grayscale().raw().toBuffer();
  let sx = 0;
  let sy = 0;
  let n = 0;
  const THRESH = 175;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (raw[y * W + x]! > THRESH) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  const coverage = n / (W * H);
  if (n < 500 || coverage > 0.92 || coverage < 0.08) return 0;
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (raw[y * W + x]! > THRESH) {
        const dx = x - mx;
        const dy = y - my;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
    }
  }
  // Major axis angle from x-axis; a portrait page should sit at 90.
  const theta = (Math.atan2(2 * sxy, sxx - syy) / 2) * (180 / Math.PI);
  let major = theta;
  // atan2 gives the minor axis when sxx > syy; add 90 to get the major.
  if (sxx > syy) major += 90;
  const skew = major - 90;
  const wrapped = ((skew + 90) % 180) - 90;
  return Math.abs(wrapped) > 45 ? 0 : wrapped;
}

export interface PaperBox {
  box: Box;
  score: number;
}

// On-device paper detection: bright connected regions (paper on a
// darker table) become page boxes, split along long internal shadow
// lines where letters overlap. Used when SAM returns nothing usable.
// Returns [] when no split was found and the caller should read the
// whole frame.
export async function detectPaperBoxes(image: NormalizedImage): Promise<PaperBox[]> {
  const W = 400;
  const img = await sharpOf(image.buffer);
  const meta = await img.metadata();
  const aspect = (meta.height ?? 1) / (meta.width ?? 1);
  const H = Math.max(1, Math.round(W * aspect));
  const gray = await img.resize(W, H, { fit: "fill" }).grayscale().raw().toBuffer();

  const labels = new Int32Array(W * H).fill(-1);
  const comps: { area: number; xmin: number; ymin: number; xmax: number; ymax: number }[] = [];
  const THRESH = 165;
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (gray[i]! <= THRESH || labels[i] !== -1) continue;
    const id = comps.length;
    const comp = { area: 0, xmin: W, ymin: H, xmax: 0, ymax: 0 };
    stack.push(i);
    labels[i] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = Math.floor(p / W);
      comp.area += 1;
      if (x < comp.xmin) comp.xmin = x;
      if (x > comp.xmax) comp.xmax = x;
      if (y < comp.ymin) comp.ymin = y;
      if (y > comp.ymax) comp.ymax = y;
      if (x > 0 && gray[p - 1]! > THRESH && labels[p - 1] === -1) {
        labels[p - 1] = id;
        stack.push(p - 1);
      }
      if (x < W - 1 && gray[p + 1]! > THRESH && labels[p + 1] === -1) {
        labels[p + 1] = id;
        stack.push(p + 1);
      }
      if (y > 0 && gray[p - W]! > THRESH && labels[p - W] === -1) {
        labels[p - W] = id;
        stack.push(p - W);
      }
      if (y < H - 1 && gray[p + W]! > THRESH && labels[p + W] === -1) {
        labels[p + W] = id;
        stack.push(p + W);
      }
    }
    comps.push(comp);
  }

  const total = W * H;
  const rects: { xmin: number; ymin: number; xmax: number; ymax: number; score: number }[] = [];
  for (const c of comps) {
    const w = c.xmax - c.xmin + 1;
    const h = c.ymax - c.ymin + 1;
    const coverage = c.area / total;
    if (coverage < 0.015 || coverage > 0.96) continue;
    const fill = c.area / (w * h);
    if (fill < 0.45) continue;
    const aspectWH = w / h;
    if (aspectWH < 0.35 || aspectWH > 2.8) continue;
    // One box per connected region. Stacked letters that touch stay
    // merged here; the read step separates them by sender block (see
    // extra_letter in read.ts), and SAM separates them geometrically
    // once its Responses output is enabled.
    rects.push({ xmin: c.xmin, ymin: c.ymin, xmax: c.xmax, ymax: c.ymax, score: 0.55 });
  }
  // Near-full-frame single rect means no table edge was visible: no split.
  if (rects.length === 1) {
    const r = rects[0]!;
    if ((r.xmax - r.xmin + 1) * (r.ymax - r.ymin + 1) > total * 0.93) return [];
  }
  const boxes = rects.map((r) => ({
    box: clampBox({
      ymin: (r.ymin / H) * 1000,
      xmin: (r.xmin / W) * 1000,
      ymax: ((r.ymax + 1) / H) * 1000,
      xmax: ((r.xmax + 1) / W) * 1000,
    }),
    score: r.score,
  }));
  boxes.sort((a, b) => b.score - a.score);
  return boxes.filter((b, i) => boxes.slice(0, i).every((k) => iou(k.box, b.box) < 0.85));
}

export interface TrackedDetection<T> {
  trackId: number;
  frameIndex: number;
  detection: T;
}

// Greedy tracking across frames. Each detection joins the open track
// with the best IoU above minIou, else it starts a track. The optional
// isSame check (e.g. appearance) vetoes merges of lookalike boxes that
// show different letters.
export function trackBoxes<T extends { box: Box }>(
  frames: T[][],
  minIou = 0.3,
  isSame: (prev: T, next: T) => boolean = () => true,
): TrackedDetection<T>[][] {
  const tracks: TrackedDetection<T>[][] = [];
  const openLast: { trackIdx: number; box: Box; det: T }[] = [];
  frames.forEach((dets, frameIndex) => {
    const used = new Set<number>();
    dets.forEach((det) => {
      let best = -1;
      let bestIou = minIou;
      openLast.forEach((open, i) => {
        if (used.has(i)) return;
        const v = iou(open.box, det.box);
        if (v > bestIou && isSame(open.det, det)) {
          bestIou = v;
          best = i;
        }
      });
      if (best >= 0) {
        used.add(best);
        const track = tracks[openLast[best]!.trackIdx]!;
        track.push({ trackId: openLast[best]!.trackIdx, frameIndex, detection: det });
        openLast[best] = { trackIdx: openLast[best]!.trackIdx, box: det.box, det };
      } else {
        const trackIdx = tracks.length;
        tracks.push([{ trackId: trackIdx, frameIndex, detection: det }]);
        openLast.push({ trackIdx, box: det.box, det });
      }
    });
  });
  return tracks;
}

// Difference hash of a detection region: 64-bit hex string. Same
// letter across frames hashes close; different letters hash apart.
export async function regionHash(image: NormalizedImage, box: Box): Promise<string> {
  const { left, top, w, h } = boxToPixels(box, image.width, image.height);
  const raw = await (await sharpOf(image.buffer)).extract({ left, top, width: w, height: h }).resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let lo = 0;
  let hi = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = raw[y * 9 + x]! > raw[y * 9 + x + 1]! ? 1 : 0;
      const pos = y * 8 + x;
      if (pos < 32) lo |= bit << pos;
      else hi |= bit << (pos - 32);
    }
  }
  return (lo >>> 0).toString(16).padStart(8, "0") + (hi >>> 0).toString(16).padStart(8, "0");
}

export function hashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x > 0) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

// Shrink a crop for model input. Returned boxes stay valid: they are
// 0-1000 relative to the crop.
export async function downscaleForModel(image: NormalizedImage, maxSide = MAX_MODEL_SIDE): Promise<Buffer> {
  if (Math.max(image.width, image.height) <= maxSide) return image.buffer;
  return (await sharpOf(image.buffer))
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
