import { describe, expect, it } from "vitest";
import { isRealBox, textInTranscription, verifyField } from "../src/citations.js";

const TRANSCRIPT = "Sacramento County Medi-Cal Office\nRenewal due November 20, 2026. Call (555) 100-2000.";

describe("isRealBox", () => {
  it("accepts a normal box", () => {
    expect(isRealBox({ ymin: 40, xmin: 60, ymax: 70, xmax: 400 })).toBe(true);
  });
  it("rejects null, degenerate and inverted boxes", () => {
    expect(isRealBox(null)).toBe(false);
    expect(isRealBox({ ymin: 40, xmin: 60, ymax: 40, xmax: 400 })).toBe(false);
    expect(isRealBox({ ymin: 40, xmin: 60, ymax: 70, xmax: 60 })).toBe(false);
    expect(isRealBox({ ymin: 40, xmin: 60, ymax: 41, xmax: 61 })).toBe(false);
    expect(isRealBox({ ymin: 70, xmin: 400, ymax: 40, xmax: 60 })).toBe(false);
  });
});

describe("textInTranscription", () => {
  it("matches case- and whitespace-insensitively", () => {
    expect(textInTranscription("sacramento county medi-cal office", TRANSCRIPT)).toBe(true);
    expect(textInTranscription("November  20,\n2026", TRANSCRIPT)).toBe(true);
  });
  it("matches across punctuation differences", () => {
    expect(textInTranscription("5551002000", TRANSCRIPT)).toBe(true);
    expect(textInTranscription("(555) 100-2000", "call 5551002000 today")).toBe(true);
  });
  it("rejects invented text and fragments", () => {
    expect(textInTranscription("December 99, 2099", TRANSCRIPT)).toBe(false);
    expect(textInTranscription("", TRANSCRIPT)).toBe(false);
    expect(textInTranscription("x", TRANSCRIPT)).toBe(false);
  });
});

describe("verifyField", () => {
  it("needs both a real box and text in the transcription", () => {
    const box = { ymin: 40, xmin: 60, ymax: 70, xmax: 400 };
    expect(verifyField({ text: "November 20, 2026", box }, TRANSCRIPT)).toBe(true);
    expect(verifyField({ text: "November 20, 2026", box: null }, TRANSCRIPT)).toBe(false);
    expect(verifyField({ text: "January 1, 2030", box }, TRANSCRIPT)).toBe(false);
    expect(verifyField({ text: null, box }, TRANSCRIPT)).toBe(false);
  });
});
