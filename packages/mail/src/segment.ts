// Segmentation: SAM 3.1 finds each letter, envelope or page in a photo
// or video frame. The request is a Responses call with the image plus a
// text prompt, asking for detections with boxes in 0-1000 coordinates.
// The parser accepts several box shapes because hosted segmentation
// output varies; when SAM is unreachable or returns nothing usable, the
// pipeline falls back to the whole frame as one page and says so.

import { SEGMENT_MODEL, type ModelClient } from "./model.js";
import { clampBox, detectPaperBoxes, iou, type NormalizedImage } from "./media.js";
import type { Box } from "./types.js";

export interface Detection {
  box: Box;
  label: string;
  score: number;
}

export type SegmentMethod = "sam" | "local" | "full-frame";

export interface SegmentResult {
  detections: Detection[];
  method: SegmentMethod;
  usage: { inputTokens: number; outputTokens: number } | null;
  elapsedMs: number;
}

const SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    detections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          box_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          label: { type: "string" },
          score: { type: "number" },
        },
        required: ["box_2d", "label"],
      },
    },
  },
  required: ["detections"],
} as Record<string, unknown>;

const SEGMENT_PROMPT =
  "Find every letter, envelope, and page of mail in this photo. " +
  "A pile of mail can hold several overlapping letters; return one box per letter or page. " +
  "Boxes are [ymin, xmin, ymax, xmax] in 0-1000 coordinates relative to the image. " +
  "Label each box letter, envelope, or page.";

const PAPER_LABELS = ["letter", "envelope", "page", "paper", "document", "mail", "notice", "form"];

function isPaperLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return PAPER_LABELS.some((p) => lower.includes(p));
}

function numArray(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  const nums = v.slice(0, 4).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

// Accept box_2d ([ymin,xmin,ymax,xmax]), bbox/box ([xmin,ymin,xmax,ymax]
// or [ymin,xmin,ymax,xmax] guessed by aspect sanity), and polygon point
// lists reduced to a bounding box.
function boxFromItem(item: Record<string, unknown>): Box | null {
  const direct = numArray(item["box_2d"]);
  if (direct) return clampBox({ ymin: direct[0]!, xmin: direct[1]!, ymax: direct[2]!, xmax: direct[3]! });
  for (const key of ["bbox", "box"]) {
    const arr = numArray(item[key]);
    if (arr) {
      // Assume [xmin, ymin, xmax, ymax] unless the values look 0-1
      // normalized, in which case scale up.
      const scaled = arr.every((n) => n >= 0 && n <= 1) ? arr.map((n) => n * 1000) : arr;
      return clampBox({ ymin: scaled[1]!, xmin: scaled[0]!, ymax: scaled[3]!, xmax: scaled[2]! });
    }
  }
  const poly = item["polygon"] ?? item["points"] ?? item["mask_polygon"];
  if (Array.isArray(poly) && poly.length >= 3) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of poly) {
      if (Array.isArray(p) && p.length >= 2) {
        const x = Number(p[0]);
        const y = Number(p[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    if (xs.length >= 3) {
      let xmin = Math.min(...xs);
      let xmax = Math.max(...xs);
      let ymin = Math.min(...ys);
      let ymax = Math.max(...ys);
      if (xmax <= 1 && ymax <= 1) {
        xmin *= 1000;
        xmax *= 1000;
        ymin *= 1000;
        ymax *= 1000;
      }
      return clampBox({ ymin, xmin, ymax, xmax });
    }
  }
  return null;
}

function area(box: Box): number {
  return Math.max(0, box.xmax - box.xmin) * Math.max(0, box.ymax - box.ymin);
}

export function parseDetections(text: string): Detection[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Some models wrap JSON in fences; try the first {...} span.
    const span = text.match(/\{[\s\S]*\}/);
    if (!span) return [];
    try {
      data = JSON.parse(span[0]);
    } catch {
      return [];
    }
  }
  const root = data as Record<string, unknown>;
  const list = Array.isArray(root) ? root : (root["detections"] ?? root["boxes"] ?? root["instances"] ?? []);
  if (!Array.isArray(list)) return [];
  const out: Detection[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const box = boxFromItem(item);
    if (!box || area(box) < 2000) continue;
    const label = typeof item["label"] === "string" ? (item["label"] as string) : "page";
    const score = typeof item["score"] === "number" ? (item["score"] as number) : 1;
    if (!isPaperLabel(label) && score < 0.9) continue;
    out.push({ box, label, score });
  }
  // Drop near-duplicate boxes, keeping the higher score.
  out.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const det of out) {
    if (kept.every((k) => iou(k.box, det.box) < 0.9)) kept.push(det);
  }
  return kept;
}

function toDataUrl(image: NormalizedImage): string {
  return `data:image/jpeg;base64,${image.buffer.toString("base64")}`;
}

export function fullFrameDetection(): Detection {
  return { box: { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 }, label: "page", score: 0 };
}

export async function segmentFrame(image: NormalizedImage, model: ModelClient): Promise<SegmentResult> {
  const started = Date.now();
  try {
    const res = await model.responses({
      model: SEGMENT_MODEL,
      store: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: SEGMENT_PROMPT },
            { type: "input_image", image_url: toDataUrl(image), detail: "high" },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "mail_detections", schema: SEGMENT_SCHEMA, strict: true } },
      max_output_tokens: 2000,
    });
    const detections = parseDetections(res.text);
    if (detections.length > 0) {
      return { detections, method: "sam", usage: res.usage, elapsedMs: Date.now() - started };
    }
    return await localOrFullFrame(image, res.usage, started);
  } catch {
    return await localOrFullFrame(image, null, started);
  }
}

async function localOrFullFrame(
  image: NormalizedImage,
  usage: SegmentResult["usage"],
  started: number,
): Promise<SegmentResult> {
  try {
    const local = await detectPaperBoxes(image);
    if (local.length > 0) {
      return {
        detections: local.map((l) => ({ box: l.box, label: "page", score: l.score })),
        method: "local",
        usage,
        elapsedMs: Date.now() - started,
      };
    }
  } catch {
    // Fall through to the whole frame.
  }
  return { detections: [fullFrameDetection()], method: "full-frame", usage, elapsedMs: Date.now() - started };
}
