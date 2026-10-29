import { describe, expect, it } from "vitest";
import { EMAIL_A, EMAIL_B, PHONE_A, PHONE_B, testSetup } from "./helpers";

// Item 3: a fresh phone code verified in THIS session gates every path that
// adds an email to a phone-only account, merge included. Freshness is per
// session, not per person.
describe("fresh phone proof per session", () => {
  it("phone verified in session B does not satisfy session A", async () => {
    let now = Date.now();
    const { service, workos, codes } = testSetup(() => now);
    await service.routeTextHandle("phone", PHONE_A);
    const first = await codes.requestCodeForTest(PHONE_A);
    const sessionA = await service.verifyPhoneCode(PHONE_A, first!.code);
    now += 11 * 60 * 1000;
    // Same person signs in again elsewhere. Session B is fresh.
    const second = await codes.requestCodeForTest(PHONE_A);
    const sessionB = await service.verifyPhoneCode(PHONE_A, second!.code);
    expect(sessionB.personId).toBe(sessionA.personId);
    // But session A is stale, so adding email there still refuses.
    workos.addUser(
      { id: "user_fresh_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "fresh-code-001",
    );
    await expect(service.completeEmailSignIn("fresh-code-001", sessionA.sessionToken)).rejects.toThrow(
      /fresh code/,
    );
  });

  it("merging an email account into a phone-only account needs a fresh phone code in this session", async () => {
    let now = Date.now();
    const { service, workos, codes } = testSetup(() => now);
    const phoneOnly = await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    expect(signed.personId).toBe(phoneOnly.personId);
    now += 11 * 60 * 1000;
    // The email side exists elsewhere.
    workos.addUser(
      { id: "user_fresh_002", email: EMAIL_B, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "fresh-code-002",
    );
    const emailSigned = await service.completeEmailSignIn("fresh-code-002");
    // Prove the email side inside the phone session (conflict, not a silent merge).
    workos.addUser(
      { id: "user_fresh_002", email: EMAIL_B, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "fresh-code-003",
    );
    await expect(service.completeEmailSignIn("fresh-code-003", signed.sessionToken)).rejects.toThrow(
      /already belongs/,
    );
    const { previewId } = await service.previewMerge(signed.sessionToken, emailSigned.personId);
    // Stale phone proof: the merge that would add the email refuses.
    await expect(service.confirmMerge(signed.sessionToken, previewId, true)).rejects.toThrow(/fresh code/);
  });

  it("merging into a phone-only account works with a fresh phone code in this session", async () => {
    const { service, workos, codes } = testSetup();
    const phoneOnly = await service.routeTextHandle("phone", PHONE_B);
    const req = await codes.requestCodeForTest(PHONE_B);
    const signed = await service.verifyPhoneCode(PHONE_B, req!.code);
    expect(signed.personId).toBe(phoneOnly.personId);
    workos.addUser(
      { id: "user_fresh_004", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "fresh-code-004",
    );
    const emailSigned = await service.completeEmailSignIn("fresh-code-004");
    workos.addUser(
      { id: "user_fresh_004", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "fresh-code-005",
    );
    await expect(service.completeEmailSignIn("fresh-code-005", signed.sessionToken)).rejects.toThrow(
      /already belongs/,
    );
    const { previewId } = await service.previewMerge(signed.sessionToken, emailSigned.personId);
    const account = await service.confirmMerge(signed.sessionToken, previewId, true);
    expect(account.identities.map((i) => i.kind)).toContain("email");
  });
});
