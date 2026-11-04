/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PORTAL_DECLARATION, createExecutor } from "../src/gateway/executors.js";
import type { ActionRequest } from "../src/gateway/types.js";

// The engine refuses a sandbox filing before the approval question by the
// portal's own limits, so the two deployed configs must name the same
// numbers. A change to one wrangler.toml without the other fails here.
function vars(path: string): Record<string, string> {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const section = text.split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  return Object.fromEntries([...section.matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));
}

const engine = vars("../wrangler.toml");
const portal = vars("../../sandbox-portal/wrangler.toml");

function submit(address: string, documentBytes: number): ActionRequest {
  const bytes = new Uint8Array(documentBytes);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return {
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: {
      caseNumber: "WA-SNAP-0042117",
      fullName: "Rosa Testcase",
      dateOfBirth: "1984-03-12",
      address,
      phone: "253-555-0142",
      householdSize: "3",
      monthlyIncome: "2150",
      declaration: PORTAL_DECLARATION,
    },
    idempotencyKey: "agent:g1:turn-1:d0",
    actor: "foreground",
    personId: "person-rosa",
    document: { bytesB64: Buffer.from(bytes).toString("base64"), hash: "h" },
  };
}

describe("sandbox portal limits: engine config matches the portal's", () => {
  it("names the portal's field and upload limits in the engine's wrangler.toml", () => {
    expect(portal.MAX_FIELD_LENGTH).toMatch(/^\d+$/);
    expect(portal.MAX_UPLOAD_BYTES).toMatch(/^\d+$/);
    expect(engine.SANDBOX_MAX_FIELD_LENGTH).toBe(portal.MAX_FIELD_LENGTH);
    expect(engine.SANDBOX_MAX_UPLOAD_BYTES).toBe(portal.MAX_UPLOAD_BYTES);
  });

  it("builds the sandbox executor with those limits", () => {
    const executor = createExecutor({
      ...engine,
      EXECUTOR_MODE: "sandbox",
      SANDBOX_BASE_URL: "https://portal.test",
      SANDBOX_PORTAL_TOKEN: "portal-test-token",
    });
    const field = Number(portal.MAX_FIELD_LENGTH);
    const upload = Number(portal.MAX_UPLOAD_BYTES);
    expect(executor.refuse?.(submit("x".repeat(field), upload))).toBeNull();
    expect(executor.refuse?.(submit("x".repeat(field + 1), upload))).toMatch(/longer than/);
    expect(executor.refuse?.(submit("x", upload + 1))).toMatch(/larger than/);
  });

  it("fails loud on a limit that is not a whole number above 0", () => {
    const build = (value: string) =>
      createExecutor({
        EXECUTOR_MODE: "sandbox",
        SANDBOX_BASE_URL: "https://portal.test",
        SANDBOX_PORTAL_TOKEN: "portal-test-token",
        SANDBOX_MAX_FIELD_LENGTH: value,
      });
    expect(() => build("lots")).toThrow(/SANDBOX_MAX_FIELD_LENGTH/);
    expect(() => build("0")).toThrow(/SANDBOX_MAX_FIELD_LENGTH/);
  });
});
