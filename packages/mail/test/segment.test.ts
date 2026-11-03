import { describe, expect, it } from "vitest";
import { readMail } from "../src/index.js";
import { normalizeImage } from "../src/media.js";
import { MetaModelClient, RecordedModelClient, recordedText, strictSchemaErrors } from "../src/model.js";
import { parseDetections, segmentFrame } from "../src/segment.js";
import { letterPhoto, pageJson } from "./letter-fixture.js";

// Meta's API answer to every call while billing is off (HTTP 402), as
// recorded by packages/quality's provider check.
const BILLING_402 = JSON.stringify({
  error: { message: "Billing is not configured for this account.", type: "billing_error", code: "billing_not_configured" },
});
const billingOff = () =>
  new MetaModelClient({
    apiKey: "test-key",
    synthetic: true,
    fetchFn: (async () => new Response(BILLING_402, { status: 402 })) as typeof fetch,
  });
const MALFORMED = '{"detections":[{"box_2d":[null,null,500,900]}]}';

// LAP-755: SAM 3.1 answered every call with HTTP 400 "Missing 'score'"
// because the detection schema left score out of required.
describe("segmentFrame", () => {
  const sam = (result: string) =>
    new RecordedModelClient([{ match: (req) => req.model === "sam-3.1", result: recordedText(result) }]);

  it("sends SAM 3.1 a strict schema that lists every property as required", async () => {
    const model = sam('{"detections":[{"box_2d":[80,120,950,880],"label":"letter","score":0.9}]}');
    await segmentFrame(await normalizeImage(await letterPhoto(), "image/jpeg"), model);
    const format = model.calls[0]!.text!.format!;
    expect(format).toMatchObject({ type: "json_schema", name: "mail_detections", strict: true });
    expect(strictSchemaErrors(format.schema)).toEqual([]);
  });

  it("splits the photo with SAM's boxes when SAM answers", async () => {
    const model = sam('{"detections":[{"box_2d":[80,120,950,880],"label":"letter","score":0.9}]}');
    const seg = await segmentFrame(await normalizeImage(await letterPhoto(), "image/jpeg"), model);
    expect(seg.method).toBe("sam");
    expect(seg.detections).toEqual([{ box: { ymin: 80, xmin: 120, ymax: 950, xmax: 880 }, label: "letter", score: 0.9 }]);
  });

  it("falls back to on-device detection when SAM refuses the call", async () => {
    const model = new RecordedModelClient([]);
    const seg = await segmentFrame(await normalizeImage(await letterPhoto(), "image/jpeg"), model);
    expect(seg.method).not.toBe("sam");
    expect(seg.detections.length).toBeGreaterThan(0);
  });

  // Review of PR 109: a detection with null coordinates and no label or
  // score became a trusted crop of [0, 0, 500, 900], label "page", score 1.
  it("review should: never trusts a malformed detection, and falls back on-device saying why", async () => {
    const seg = await segmentFrame(await normalizeImage(await letterPhoto(), "image/jpeg"), sam(MALFORMED));
    expect(seg.method).toBe("local");
    expect(seg.detections).not.toContainEqual(expect.objectContaining({ box: { ymin: 0, xmin: 0, ymax: 500, xmax: 900 } }));
    expect(seg.method !== "sam" && seg.why).toMatch(/box_2d/);
  });

  it("says the API's own error when the call fails", async () => {
    const seg = await segmentFrame(await normalizeImage(await letterPhoto(), "image/jpeg"), billingOff());
    expect(seg.method).not.toBe("sam");
    expect(seg.method !== "sam" && seg.why).toMatch(/402.*Billing is not configured for this account\./);
  });
});

describe("the segmentation warning", () => {
  const fallbackOf = async (model: RecordedModelClient | MetaModelClient) => {
    const reading = await readMail([{ bytes: await letterPhoto(), mimeType: "image/jpeg", name: "doc-1" }], {
      personId: "p1",
      synthetic: true,
      model,
    });
    return reading.warnings.find((w) => w.kind === "segmentation_fallback");
  };

  it("names what was wrong with SAM's answer", async () => {
    const warning = await fallbackOf(
      new RecordedModelClient([
        { match: (req) => req.model === "sam-3.1", result: recordedText(MALFORMED) },
        { match: (req) => req.model !== "sam-3.1", consume: true, result: recordedText(pageJson()) },
      ]),
    );
    expect(warning?.detail).toMatch(/box_2d/);
  });

  it("carries the API's error message when the call failed", async () => {
    const warning = await fallbackOf(billingOff());
    expect(warning?.detail).toMatch(/402.*Billing is not configured for this account\./);
  });
});

describe("parseDetections", () => {
  const VALID = { box_2d: [520, 20, 990, 900], label: "letter", score: 0.9 };
  const KEPT = { box: { ymin: 520, xmin: 20, ymax: 990, xmax: 900 }, label: "letter", score: 0.9 };
  const at = { box_2d: [10, 20, 500, 900] };

  it("parses box_2d detections", () => {
    const parsed = parseDetections(JSON.stringify({ detections: [VALID] }));
    expect(parsed.detections).toEqual([KEPT]);
  });

  // Each is SAM's answer with one thing wrong, beside one good detection.
  const MALFORMED_DETECTIONS: [string, Record<string, unknown>][] = [
    ["null coordinates", { ...VALID, box_2d: [null, null, 500, 900] }],
    ["three coordinates", { ...VALID, box_2d: [10, 20, 500] }],
    ["five coordinates", { ...VALID, box_2d: [10, 20, 500, 900, 4] }],
    ["coordinates as strings", { ...VALID, box_2d: ["10", "20", "500", "900"] }],
    ["a coordinate below 0", { ...VALID, box_2d: [-5, 20, 500, 900] }],
    ["a coordinate above 1000", { ...VALID, box_2d: [10, 20, 1500, 900] }],
    ["ymin past ymax", { ...VALID, box_2d: [500, 20, 10, 900] }],
    ["xmin past xmax", { ...VALID, box_2d: [10, 900, 500, 20] }],
    ["no area", { ...VALID, box_2d: [10, 20, 10, 900] }],
    ["no box", { label: "letter", score: 0.9 }],
    ["no label", { ...at, score: 0.9 }],
    ["an empty label", { ...at, label: " ", score: 0.9 }],
    ["no score", { ...at, label: "letter" }],
    ["a null score", { ...at, label: "letter", score: null }],
    ["a score as a string", { ...at, label: "letter", score: "0.9" }],
    ["a score above 1", { ...at, label: "letter", score: 1.5 }],
  ];

  it.each(MALFORMED_DETECTIONS)("drops a detection with %s and keeps the good one", (_what, bad) => {
    const parsed = parseDetections(JSON.stringify({ detections: [bad, VALID] }));
    expect(parsed.detections).toEqual([KEPT]);
  });

  it("says why when no detection is usable", () => {
    const parsed = parseDetections(JSON.stringify({ detections: [{ box_2d: [null, null, 500, 900] }] }));
    expect(parsed.detections).toEqual([]);
    expect(parsed.problems.join("; ")).toMatch(/box_2d/);
  });

  it("drops tiny boxes and non-paper labels", () => {
    const parsed = parseDetections(
      JSON.stringify({
        detections: [
          { box_2d: [0, 0, 5, 5], label: "letter", score: 0.9 },
          { box_2d: [10, 20, 500, 900], label: "cat", score: 0.5 },
        ],
      }),
    );
    expect(parsed.detections).toEqual([]);
    expect(parsed.problems).toHaveLength(2);
  });

  it("dedupes near-identical boxes", () => {
    const parsed = parseDetections(
      JSON.stringify({
        detections: [
          { box_2d: [10, 20, 500, 900], label: "letter", score: 0.9 },
          { box_2d: [12, 22, 500, 900], label: "letter", score: 0.5 },
        ],
      }),
    );
    expect(parsed.detections).toHaveLength(1);
    expect(parsed.detections[0]!.score).toBe(0.9);
  });

  it("returns nothing for an answer that is not the detections it asked for", () => {
    for (const text of ["not json", JSON.stringify({ detections: "nope" }), JSON.stringify([VALID])]) {
      const parsed = parseDetections(text);
      expect(parsed.detections).toEqual([]);
      expect(parsed.problems.length).toBeGreaterThan(0);
    }
  });
});
