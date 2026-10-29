import { describe, expect, it } from "vitest";
import { sessionRouteGuard } from "../lib/route-guard";

describe("sessionRouteGuard", () => {
  it("sends signed-out people to sign-in from every guarded route", () => {
    for (const root of ["(tabs)", "approvals", "documents", "access", "language", "about"]) {
      expect(sessionRouteGuard("signed-out", root)).toBe("sign-in");
    }
  });

  it("leaves the entry route and the auth screens to redirect themselves", () => {
    expect(sessionRouteGuard("signed-out", undefined)).toBe("stay");
    expect(sessionRouteGuard("signed-out", "(auth)")).toBe("stay");
  });

  it("never redirects while loading or signed in", () => {
    for (const root of [undefined, "(auth)", "(tabs)", "documents"]) {
      expect(sessionRouteGuard("loading", root)).toBe("stay");
      expect(sessionRouteGuard("signed-in", root)).toBe("stay");
    }
  });
});
