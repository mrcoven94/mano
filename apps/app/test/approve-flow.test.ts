import { describe, expect, it } from "vitest";
import { approveOutcome } from "../lib/approve-result";
import { canShowBytes, canShowInApp, navigationAllowed, sniffMime } from "../lib/doc-show";
import { utf8ToB64 } from "../lib/base64";
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

describe("sniffMime", () => {
  it("trusts declared types and sniffs octet-stream", () => {
    expect(sniffMime("text/plain", "aGk=")).toBe("text/plain");
    expect(sniffMime("application/octet-stream", utf8ToB64("hello"))).toBe("text/plain");
    expect(sniffMime("application/octet-stream", utf8ToB64("%PDF-1.4"))).toBe("application/pdf");
    expect(sniffMime("application/octet-stream", "iVBORw0KGgo=")).toBe("image/png");
    expect(sniffMime("application/octet-stream", "/9j/")).toBe("image/jpeg");
    expect(sniffMime("application/octet-stream", "R0lGODlh")).toBe("image/gif");
    expect(sniffMime("application/octet-stream", "AAEC")).toBe("application/octet-stream");
  });
});

describe("canShowBytes", () => {
  it("treats undecodable bytes as unviewable, never a crash", () => {
    expect(canShowBytes("application/pdf", "JVBERi0xLjQKJeLjz9M=", "web")).toBe(true);
    expect(canShowBytes("application/octet-stream", "!!!not-base64!!!", "web")).toBe(false);
    expect(canShowBytes("application/pdf", "!!!not-base64!!!", "android")).toBe(false);
  });
});

describe("navigationAllowed", () => {
  it("loads only the document itself", () => {
    expect(navigationAllowed("file:///doc.pdf", "file:///doc.pdf")).toBe(true);
    expect(navigationAllowed("about:blank", "file:///doc.pdf")).toBe(true);
    expect(navigationAllowed("https://example.com/", "file:///doc.pdf")).toBe(false);
    expect(navigationAllowed("file:///doc.pdf#page=2", "file:///doc.pdf")).toBe(true);
    expect(navigationAllowed("file:///etc/passwd", "file:///doc.pdf")).toBe(false);
  });
});
