import { describe, expect, it } from "vitest";
import {
  HANDLE_GRANT_MAX_TTL_SECONDS,
  handleForPersonId,
  mintHandleGrant,
  personIdForHandle,
  verifyHandleGrant,
} from "../src/index.js";

const SECRET = "test-handle-grant-secret-not-real";
const HANDLE = "a".repeat(64);

describe("handle grants", () => {
  it("round-trips the handle and maps it to one person", async () => {
    const grant = await mintHandleGrant(HANDLE, SECRET);
    const claims = await verifyHandleGrant(grant, SECRET);
    expect(claims?.handle).toBe(HANDLE);
    expect(personIdForHandle(HANDLE)).toBe(`handle-${HANDLE}`);
    expect(handleForPersonId(personIdForHandle(HANDLE))).toBe(HANDLE);
    expect(handleForPersonId("maria")).toBeNull();
  });

  it("rejects a grant signed with another secret or edited in transit", async () => {
    const grant = await mintHandleGrant(HANDLE, SECRET);
    expect(await verifyHandleGrant(grant, "another-secret")).toBeNull();
    const [prefix, , mac] = grant.split(".");
    const forged = btoa(JSON.stringify({ v: 1, handle: "b".repeat(64), iat: 1, exp: 4_000_000_000 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyHandleGrant(`${prefix}.${forged}.${mac}`, SECRET)).toBeNull();
  });

  it("rejects expired grants and lifetimes over the maximum", async () => {
    const now = Date.now();
    const grant = await mintHandleGrant(HANDLE, SECRET, 60, now);
    expect(await verifyHandleGrant(grant, SECRET, now + 61_000)).toBeNull();
    await expect(mintHandleGrant(HANDLE, SECRET, HANDLE_GRANT_MAX_TTL_SECONDS + 1)).rejects.toThrow(/lifetime/);
  });

  it("refuses handles that are not a 64-hex hash", async () => {
    await expect(mintHandleGrant("+18015550100", SECRET)).rejects.toThrow(/64 lowercase hex/);
    expect(() => personIdForHandle("maria")).toThrow(/64 lowercase hex/);
  });
});
