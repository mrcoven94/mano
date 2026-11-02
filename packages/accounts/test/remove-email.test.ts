import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, testSetup } from "./helpers";

// Item 4: removing an email unlinks the WorkOS identity in the same step,
// so signing in through that WorkOS identity fails afterwards.
describe("removing an email unlinks WorkOS sign-in", () => {
  it("sign-in via the removed WorkOS identity fails", async () => {
    const { service, workos, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    workos.addUser(
      { id: "user_unlink_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "unlink-code-001",
    );
    await service.completeEmailSignIn("unlink-code-001", signed.sessionToken);
    const before = await service.getAccount(signed.sessionToken);
    expect(before.identities.map((i) => i.kind)).toContain("email");
    const email = before.identities.find((i) => i.kind === "email");
    const after = await service.removeIdentity(signed.sessionToken, email!.id);
    expect(after.identities.map((i) => i.kind)).not.toContain("email");
    expect(after.identities.map((i) => i.kind)).not.toContain("workos");
    // Same WorkOS identity tries to sign in again. It must fail, not open
    // the account and not silently create a new person.
    workos.addUser(
      { id: "user_unlink_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "unlink-code-002",
    );
    await expect(service.completeEmailSignIn("unlink-code-002")).rejects.toThrow();
  });
});
