import { describe, expect, it } from "vitest";
import { colors } from "../lib/theme";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("field borders", () => {
  it("meet 3:1 against the white a field sits on", () => {
    expect(contrast(colors.fieldBorder, colors.bg)).toBeGreaterThanOrEqual(3);
  });

  it("leave the decorative border as it was", () => {
    expect(colors.border2).toBe("#D6D3CC");
  });
});
