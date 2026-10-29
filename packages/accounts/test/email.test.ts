import { describe, expect, it } from "vitest";
import { EMAIL_A, testSetup } from "./helpers";

describe("email sign-in through WorkOS", () => {
  it("exchanges a WorkOS user for an engine session", async () => {
    const { service, workos } = testSetup();
    workos.addUser(
      { id: "user_synth_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "workos-code-001",
    );
    const url = service.startEmailSignIn("state-1");
    expect(url).toContain("state-1");
    const signed = await service.completeEmailSignIn("workos-code-001");
    expect(signed.personId).toBeTruthy();
    expect(signed.sessionToken).toBeTruthy();
    const account = await service.getAccount(signed.sessionToken);
    expect(account.identities.some((i) => i.kind === "email")).toBe(true);
    expect(account.identities.some((i) => i.kind === "workos")).toBe(true);
  });

  it("signs the same person in again on the second WorkOS code", async () => {
    const { service, workos } = testSetup();
    workos.addUser(
      { id: "user_synth_002", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "workos-code-002",
    );
    const first = await service.completeEmailSignIn("workos-code-002");
    workos.addUser(
      { id: "user_synth_002", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "workos-code-003",
    );
    const second = await service.completeEmailSignIn("workos-code-003");
    expect(second.personId).toBe(first.personId);
  });

  it("refuses unverified email", async () => {
    const { service, workos } = testSetup();
    workos.addUser(
      { id: "user_synth_003", email: EMAIL_A, emailVerified: false, firstName: null, lastName: null, organizationId: null },
      "workos-code-004",
    );
    await expect(service.completeEmailSignIn("workos-code-004")).rejects.toThrow();
  });

  it("keeps the organization seam without touching the person link", async () => {
    const { service, workos, store } = testSetup();
    workos.addUser(
      { id: "user_synth_004", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: "org_acme" },
      "workos-code-005",
    );
    const signed = await service.completeEmailSignIn("workos-code-005");
    const link = await store.getWorkosLink("user_synth_004");
    expect(link?.personId).toBe(signed.personId);
    expect(link?.organizationId).toBe("org_acme");
  });
});
