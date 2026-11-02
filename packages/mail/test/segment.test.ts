import { describe, expect, it } from "vitest";
import { parseDetections } from "../src/segment.js";

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
