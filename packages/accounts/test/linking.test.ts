import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, PHONE_B, testSetup } from "./helpers";

describe("linking", () => {
  it("links a phone to an email account after verifying it", async () => {
    const { service, workos, codes } = testSetup();
    workos.addUser(
      { id: "user_link_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "link-code-001",
    );
    const signed = await service.completeEmailSignIn("link-code-001");
    const req = await codes.requestCodeForTest(PHONE_A);
    expect(req).not.toBeNull();
    // A fresh phone with no owner links straight on after code proof.
    // Seed ownership by routing first would conflict, so link an unowned phone:
    // requestCodeForTest bypasses ownership; addPhone verifies the code then links.
    const account = await service.addPhone(signed.sessionToken, PHONE_A, req!.code);
    expect(account.identities.map((i) => i.kind).sort()).toContain("phone");
    expect(account.identities.map((i) => i.kind).sort()).toContain("email");
  });

  it("phone-only accounts need a fresh phone code before adding email", async () => {
    let now = Date.now();
    const { service, workos, codes } = testSetup(() => now);
    const routed = await service.routeTextHandle("phone", PHONE_B);
    const req = await codes.requestCodeForTest(PHONE_B);
    const signed = await service.verifyPhoneCode(PHONE_B, req!.code);
    expect(signed.personId).toBe(routed.personId);
    // Fresh: adding email works.
    workos.addUser(
      { id: "user_link_002", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "link-code-002",
    );
    const linked = await service.completeEmailSignIn("link-code-002", signed.sessionToken);
    expect(linked.linked).toBe(true);
  });

  it("stale phone proof blocks adding email", async () => {
    let now = Date.now();
    const { service, workos, codes } = testSetup(() => now);
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    now += 11 * 60 * 1000;
    workos.addUser(
      { id: "user_link_003", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "link-code-003",
    );
    await expect(service.completeEmailSignIn("link-code-003", signed.sessionToken)).rejects.toThrow(
      /fresh code/,
    );
  });

  it("linking an owned phone conflicts instead of merging silently", async () => {
    const { service, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    await service.routeTextHandle("phone", PHONE_B);
    const reqB = await codes.requestCodeForTest(PHONE_B);
    const signedB = await service.verifyPhoneCode(PHONE_B, reqB!.code);
    const reqA = await codes.requestCodeForTest(PHONE_A);
    await expect(service.addPhone(signedB.sessionToken, PHONE_A, reqA!.code)).rejects.toThrow(
      /already belongs/,
    );
  });
});
