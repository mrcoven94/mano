import { describe, expect, it } from "vitest";
import { DWELL_MS, QuestionViewing } from "../lib/question-viewing";

const T0 = 1_000_000;
const top = "a-1#top";
const bottom = "a-1#bottom";

function foregrounded(): QuestionViewing {
  const viewing = new QuestionViewing();
  viewing.enterForeground(T0);
  return viewing;
}

describe("QuestionViewing", () => {
  it("counts an edge only after it has stayed on screen for the dwell", () => {
    const viewing = foregrounded();
    viewing.setVisible(new Set([top, bottom]), T0);
    expect([...viewing.seen(T0 + DWELL_MS - 1)]).toEqual([]);
    expect([...viewing.seen(T0 + DWELL_MS)].sort()).toEqual([bottom, top]);
  });

  it("does not count an edge scrolled past before the dwell", () => {
    const viewing = foregrounded();
    viewing.setVisible(new Set([top]), T0);
    viewing.setVisible(new Set(), T0 + DWELL_MS - 1);
    expect([...viewing.seen(T0 + 5 * DWELL_MS)]).toEqual([]);
  });

  it("keeps an edge that dwelled after it scrolls away, so a tall question can be read by scrolling", () => {
    const viewing = foregrounded();
    viewing.setVisible(new Set([bottom]), T0);
    viewing.setVisible(new Set(), T0 + DWELL_MS);
    viewing.setVisible(new Set([top]), T0 + 10_000);
    const seen = viewing.seen(T0 + 10_000 + DWELL_MS);
    expect(seen.has(bottom) && seen.has(top)).toBe(true);
  });

  it("restarts the dwell on coming back: hidden time never counts", () => {
    const viewing = foregrounded();
    viewing.setVisible(new Set([top, bottom]), T0);
    viewing.leaveForeground();
    viewing.enterForeground(T0 + 60_000);
    expect([...viewing.seen(T0 + 60_000 + 1)]).toEqual([]);
    expect(viewing.seen(T0 + 60_000 + DWELL_MS).size).toBe(2);
  });

  it("counts nothing while in the background", () => {
    const viewing = new QuestionViewing();
    viewing.setVisible(new Set([top]), T0);
    expect([...viewing.seen(T0 + 60_000)]).toEqual([]);
  });

  it("forgets edges when the viewing ends, so both must be seen in one viewing", () => {
    const viewing = foregrounded();
    viewing.setVisible(new Set([bottom]), T0);
    expect(viewing.seen(T0 + DWELL_MS).has(bottom)).toBe(true);
    viewing.leaveForeground();
    viewing.setVisible(new Set([top]), T0 + 2 * DWELL_MS);
    viewing.enterForeground(T0 + 3 * DWELL_MS);
    const seen = viewing.seen(T0 + 3 * DWELL_MS + DWELL_MS);
    expect(seen.has(top)).toBe(true);
    expect(seen.has(bottom)).toBe(false);
  });

  it("says when the next edge is due, so a timer can wake exactly then", () => {
    const viewing = foregrounded();
    expect(viewing.nextDueIn(T0)).toBeNull();
    viewing.setVisible(new Set([top]), T0);
    expect(viewing.nextDueIn(T0 + 100)).toBe(DWELL_MS - 100);
  });
});
