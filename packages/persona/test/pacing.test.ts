import { describe, expect, it } from "vitest";
import { DEFAULT_HEADS_UP, routeReply } from "../src/pacing.js";

describe("routeReply", () => {
  it("answers on the fast path when there is no DEEP: line", () => {
    expect(routeReply("SNAP is food help.")).toEqual({ path: "fast", text: "SNAP is food help." });
  });

  it("takes the deep path with the heads-up from the DEEP: line", () => {
    expect(routeReply("DEEP: Let me run your Ohio numbers, one minute.")).toEqual({
      path: "deep",
      headsUp: "Let me run your Ohio numbers, one minute.",
    });
    expect(routeReply("  DEEP: Checking that.\nextra")).toEqual({ path: "deep", headsUp: "Checking that." });
  });

  it("routes deep when the model writes text before its DEEP: line", () => {
    expect(routeReply("I'll dig into that letter.DEEP: Let me look at the overpayment rules, one sec.")).toEqual({
      path: "deep",
      headsUp: "Let me look at the overpayment rules, one sec.",
    });
  });

  it("does not route on the word deep in ordinary text", () => {
    expect(routeReply("Let's go deep: first the rent.").path).toBe("fast");
  });

  it("falls back to a default heads-up when the line is empty or too long", () => {
    expect(routeReply("DEEP:")).toEqual({ path: "deep", headsUp: DEFAULT_HEADS_UP });
    expect(routeReply(`DEEP: ${"x".repeat(300)}`)).toEqual({ path: "deep", headsUp: DEFAULT_HEADS_UP });
  });
});
