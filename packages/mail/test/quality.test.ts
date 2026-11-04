import { afterEach, describe, expect, it, vi } from "vitest";

import { qualityAnswerPath, qualityDeadlineReader } from "../src/index.js";

// The bench's synthetic letter markup (packages/quality suites/art.ts).
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800" role="img">` +
  `<rect width="640" height="800" fill="#ffffff"/><rect width="640" height="64" fill="#1d4ed8"/>` +
  `<text x="40" y="42" fill="#ffffff" font-size="24">SYNTHETIC TEST LETTER</text>` +
  `<text x="40" y="120">CalFresh renewal notice</text><text x="40" y="154">Due November 15, 2026</text></svg>`;

describe("quality hooks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("are not live without a model key, and then say they could not read rather than invent", async () => {
    vi.stubEnv("META_MODEL_API_KEY", "");
    expect(qualityAnswerPath.live).toBe(false);
    expect(qualityDeadlineReader.live).toBe(false);
    const answer = await qualityAnswerPath.answer({ input: { turns: ["What does my letter say?"], images: [{ id: "letters-01-img", svg: SVG }] } });
    expect(answer.text).toMatch(/could not/i);
    expect(answer.actions).toEqual([]);
    expect(await qualityDeadlineReader.readDeadline({ id: "letters-01-img", svg: SVG })).toBeNull();
  });

  it("are live with a model key", () => {
    vi.stubEnv("META_MODEL_API_KEY", "test-key-not-used");
    expect(qualityAnswerPath.live).toBe(true);
    expect(qualityDeadlineReader.live).toBe(true);
  });
});
