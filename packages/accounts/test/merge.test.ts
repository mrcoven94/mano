import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, testSetup } from "./helpers";

describe("merge", () => {
  it("merges a text-first person into an email account after confirmation", async () => {
    const { service, codes, workos, engine } = testSetup();
    const textFirst = await service.routeTextHandle("phone", PHONE_A);
    await engine.appendThread(textFirst.personId, { role: "user", content: "text message", channel: "text" });
    engine.seedData(textFirst.personId, {
      documents: [{ id: "doc_1", name: "letter.pdf", hash: "h1" }],
      approvals: [{ id: "appr_1", status: "pending" }],
      consents: [{ recipient: "org:x", purpose: "case" }],
    });
    // Re-add the text message seed wiped by seedData.
    await engine.appendThread(textFirst.personId, { role: "user", content: "text message", channel: "text" });

    workos.addUser(
      { id: "user_merge_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "merge-code-001",
    );
    const emailSigned = await service.completeEmailSignIn("merge-code-001");
    expect(emailSigned.personId).not.toBe(textFirst.personId);

    // Verify the text identity in the email session, then preview.
    const req = await codes.requestCodeForTest(PHONE_A);
    const proof = await service.verifyPhoneForSession(emailSigned.sessionToken, PHONE_A, req!.code);
    expect(proof.samePerson).toBe(false);
    const { previewId, preview } = await service.previewMerge(emailSigned.sessionToken, textFirst.personId);
    expect(preview.fromPersonId).toBe(textFirst.personId);
    expect(preview.intoPersonId).toBe(emailSigned.personId);
    expect(preview.confirmText).toContain("messages");
    expect(preview.confirmText).toContain("documents");

    const account = await service.confirmMerge(emailSigned.sessionToken, previewId, true);
    expect(account.identities.map((i) => i.kind)).toContain("phone");
    expect(account.identities.map((i) => i.kind)).toContain("email");
    const thread = await service.getThread(emailSigned.sessionToken);
    expect(thread.map((m) => m.content)).toContain("text message");
    const counts = await engine.getDataCounts(emailSigned.personId);
    expect(counts.documents).toBe(1);
    expect(counts.approvals).toBe(1);
    expect(counts.consents).toBe(1);
    const log = await engine.activityLog(emailSigned.personId);
    expect(log.some((e) => e.event === "account.merged")).toBe(true);
  });

  it("never merges two people silently", async () => {
    const { service, codes, workos } = testSetup();
    const textFirst = await service.routeTextHandle("phone", PHONE_A);
    workos.addUser(
      { id: "user_merge_002", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "merge-code-002",
    );
    const emailSigned = await service.completeEmailSignIn("merge-code-002");
    // No link proof: preview refuses.
    await expect(service.previewMerge(emailSigned.sessionToken, textFirst.personId)).rejects.toThrow(
      /Verify the other identity/,
    );
    // Adding the owned phone conflicts instead of merging.
    const req = await codes.requestCodeForTest(PHONE_A);
    await expect(service.addPhone(emailSigned.sessionToken, PHONE_A, req!.code)).rejects.toThrow(
      /already belongs/,
    );
  });

  it("a declined merge leaves both people alone", async () => {
    const { service, codes, workos, store } = testSetup();
    const textFirst = await service.routeTextHandle("phone", PHONE_A);
    workos.addUser(
      { id: "user_merge_003", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "merge-code-003",
    );
    const emailSigned = await service.completeEmailSignIn("merge-code-003");
    const req = await codes.requestCodeForTest(PHONE_A);
    await service.verifyPhoneForSession(emailSigned.sessionToken, PHONE_A, req!.code);
    const { previewId } = await service.previewMerge(emailSigned.sessionToken, textFirst.personId);
    await expect(service.confirmMerge(emailSigned.sessionToken, previewId, false)).rejects.toThrow(
      /not confirmed/,
    );
    expect(store.getPerson(textFirst.personId)?.mergedInto).toBeNull();
    expect(store.getPerson(emailSigned.personId)?.mergedInto).toBeNull();
  });
});
