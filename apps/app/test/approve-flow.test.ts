import { describe, expect, it } from "vitest";
import { approveOutcome } from "../lib/approve-result";
import { canShowInApp } from "../lib/doc-show";
import type { ApproveResult } from "../lib/api/types";

function result(overrides: Partial<ApproveResult> = {}): ApproveResult {
  return { status: "completed", receiptId: "r-1", externalId: "x-1", simulated: false, reason: null, ...overrides };
}

describe("approveOutcome", () => {
  it("calls sent only a receipted completion", () => {
    expect(approveOutcome(result())).toBe("sent");
    expect(approveOutcome(result({ status: "reconciled" }))).toBe("sent");
    expect(approveOutcome(result({ receiptId: null }))).toBe("sending");
    expect(approveOutcome(result({ status: "blocked", receiptId: null }))).toBe("blocked");
    expect(approveOutcome(result({ status: "stale", receiptId: null }))).toBe("stale");
    expect(approveOutcome(result({ status: "needs_approval", receiptId: null }))).toBe("needs-approval");
    expect(approveOutcome(result({ status: "in_progress", receiptId: null }))).toBe("sending");
  });
});

describe("canShowInApp", () => {
  it("shows text and images everywhere", () => {
    for (const platform of ["web", "ios", "android"] as const) {
      expect(canShowInApp("text/plain", platform)).toBe(true);
      expect(canShowInApp("image/png", platform)).toBe(true);
    }
  });

  it("shows PDFs except on Android", () => {
    expect(canShowInApp("application/pdf", "web")).toBe(true);
    expect(canShowInApp("application/pdf", "ios")).toBe(true);
    expect(canShowInApp("application/pdf", "android")).toBe(false);
  });

  it("refuses unknown bytes everywhere", () => {
    for (const platform of ["web", "ios", "android"] as const) {
      expect(canShowInApp("application/octet-stream", platform)).toBe(false);
      expect(canShowInApp("application/zip", platform)).toBe(false);
    }
  });
});
