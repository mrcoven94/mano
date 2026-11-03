import { describe, expect, it } from "vitest";
import { normalizeImage } from "../src/media.js";
import { RecordedModelClient, recordedText, strictSchemaErrors } from "../src/model.js";
import { parseDetections, segmentFrame } from "../src/segment.js";
import { letterPhoto } from "./letter-fixture.js";

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
});

describe("parseDetections", () => {
  it("parses box_2d detections", () => {
    const dets = parseDetections(
      JSON.stringify({ detections: [{ box_2d: [10, 20, 500, 900], label: "letter", score: 0.9 }] }),
    );
    expect(dets).toEqual([{ box: { ymin: 10, xmin: 20, ymax: 500, xmax: 900 }, label: "letter", score: 0.9 }]);
  });
  it("parses bbox in xmin-first order", () => {
    const dets = parseDetections(JSON.stringify({ detections: [{ bbox: [20, 10, 900, 500], label: "page" }] }));
    expect(dets[0]!.box).toEqual({ ymin: 10, xmin: 20, ymax: 500, xmax: 900 });
  });
  it("scales 0-1 normalized boxes", () => {
    const dets = parseDetections(JSON.stringify({ detections: [{ bbox: [0.02, 0.01, 0.9, 0.5], label: "page" }] }));
    expect(dets[0]!.box).toEqual({ ymin: 10, xmin: 20, ymax: 500, xmax: 900 });
  });
  it("reduces polygons to boxes", () => {
    const dets = parseDetections(
      JSON.stringify({ detections: [{ polygon: [[20, 10], [900, 10], [900, 500], [20, 500]], label: "paper" }] }),
    );
    expect(dets[0]!.box).toEqual({ ymin: 10, xmin: 20, ymax: 500, xmax: 900 });
  });
  it("drops tiny boxes and non-paper labels", () => {
    const dets = parseDetections(
      JSON.stringify({
        detections: [
          { box_2d: [0, 0, 5, 5], label: "letter" },
          { box_2d: [10, 20, 500, 900], label: "cat", score: 0.5 },
        ],
      }),
    );
    expect(dets).toEqual([]);
  });
  it("dedupes near-identical boxes", () => {
    const dets = parseDetections(
      JSON.stringify({
        detections: [
          { box_2d: [10, 20, 500, 900], label: "letter", score: 0.9 },
          { box_2d: [12, 22, 500, 900], label: "letter", score: 0.5 },
        ],
      }),
    );
    expect(dets).toHaveLength(1);
    expect(dets[0]!.score).toBe(0.9);
  });
  it("returns empty for garbage", () => {
    expect(parseDetections("not json")).toEqual([]);
    expect(parseDetections(JSON.stringify({ detections: "nope" }))).toEqual([]);
  });
});
