// Segmentation: SAM 3.1 finds each letter, envelope or page in a photo
// or video frame. The request is a Responses call with the image plus a
// text prompt, asking for detections with boxes in 0-1000 coordinates
// under a strict schema. The answer is checked against that schema and a
// detection missing any part is dropped, never repaired. When SAM is
// unreachable or returns nothing usable, the pipeline falls back to
// on-device paper detection, then the whole frame, and says why.

import { SEGMENT_MODEL, type ModelClient, type ResponsesResult } from "./model.js";
import { detectPaperBoxes, iou, type NormalizedImage } from "./media.js";
import type { Box } from "./types.js";

export interface Detection {
  box: Box;
  label: string;
  score: number;
}

export type SegmentMethod = "sam" | "local" | "full-frame";

interface Segmented {
  detections: Detection[];
  usage: { inputTokens: number; outputTokens: number } | null;
  elapsedMs: number;
}

// A fallback always says why SAM's boxes were not used.
export type SegmentResult =
  | (Segmented & { method: "sam" })
  | (Segmented & { method: Exclude<SegmentMethod, "sam">; why: string });

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
        required: ["box_2d", "label", "score"],
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

function area(box: Box): number {
  return (box.xmax - box.xmin) * (box.ymax - box.ymin);
}

// SAM's answer, read against the schema it was asked for: the
// detections it may use, and why each other part was not used.
export interface ParsedDetections {
  detections: Detection[];
  problems: string[];
}

// A detection only when the model gave all of it: box_2d as four finite
// numbers from 0 to 1000 in [ymin, xmin, ymax, xmax] order with area, a
// label, and a score from 0 to 1. Otherwise why it was dropped.
function detectionOf(item: unknown): Detection | string {
  if (typeof item !== "object" || item === null) return "a detection that is not an object";
  const { box_2d: coords, label, score } = item as Record<string, unknown>;
  if (!Array.isArray(coords) || coords.length !== 4 || !coords.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)) {
    return "box_2d is not four numbers from 0 to 1000";
  }
  const [ymin, xmin, ymax, xmax] = coords as [number, number, number, number];
  if (ymin >= ymax || xmin >= xmax) return "box_2d is out of order or has no area";
  if (typeof label !== "string" || label.trim() === "") return "a detection with no label";
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return "a detection with no score from 0 to 1";
  const box = { ymin, xmin, ymax, xmax };
  if (area(box) < 2000) return "a box too small to be a page";
  if (!isPaperLabel(label) && score < 0.9) return "a box that is not mail";
  return { box, label, score };
}

export function parseDetections(text: string): ParsedDetections {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { detections: [], problems: ["the answer is not JSON"] };
  }
  const list = (data as Record<string, unknown> | null)?.["detections"];
  if (!Array.isArray(list)) return { detections: [], problems: ["the answer has no detections list"] };
  if (list.length === 0) return { detections: [], problems: ["SAM found no letter or page"] };
  const found: Detection[] = [];
  const problems: string[] = [];
  for (const item of list) {
    const detection = detectionOf(item);
    if (typeof detection === "string") problems.push(detection);
    else found.push(detection);
  }
  // Drop near-duplicate boxes, keeping the higher score.
  found.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const det of found) {
    if (kept.every((k) => iou(k.box, det.box) < 0.9)) kept.push(det);
  }
  return { detections: kept, problems };
}

function toDataUrl(image: NormalizedImage): string {
  return `data:image/jpeg;base64,${image.buffer.toString("base64")}`;
}

export function fullFrameDetection(): Detection {
  return { box: { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 }, label: "page", score: 0 };
}

export async function segmentFrame(
  image: NormalizedImage,
  model: ModelClient,
  opts: { deadline?: number } = {},
): Promise<SegmentResult> {
  const started = Date.now();
  let res: ResponsesResult;
  try {
    res = await model.responses({
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
    }, { deadline: opts.deadline });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return localOrFullFrame(image, null, started, `the SAM 3.1 call failed: ${message.slice(0, 240)}`);
  }
  const parsed = parseDetections(res.text);
  if (parsed.detections.length > 0) {
    return { detections: parsed.detections, method: "sam", usage: res.usage, elapsedMs: Date.now() - started };
  }
  return localOrFullFrame(image, res.usage, started, `SAM 3.1 gave no usable detection: ${[...new Set(parsed.problems)].join("; ")}`);
}

async function localOrFullFrame(
  image: NormalizedImage,
  usage: SegmentResult["usage"],
  started: number,
  why: string,
): Promise<SegmentResult> {
  try {
    const local = await detectPaperBoxes(image);
    if (local.length > 0) {
      return {
        detections: local.map((l) => ({ box: l.box, label: "page", score: l.score })),
        method: "local",
        why,
        usage,
        elapsedMs: Date.now() - started,
      };
    }
  } catch {
    // Fall through to the whole frame.
  }
  return { detections: [fullFrameDetection()], method: "full-frame", why, usage, elapsedMs: Date.now() - started };
}
