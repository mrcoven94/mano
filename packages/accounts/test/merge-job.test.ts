import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, testSetup } from "./helpers";

// Item 8: merge confirm carries an idempotency key and recovery state, and
// verifies the moved data still matches the confirmed preview.
describe("idempotent merge", () => {
  async function mergedSetup() {
    const ctx = testSetup();
    const { service, codes, workos, engine } = ctx;
    const textFirst = await service.routeTextHandle("phone", PHONE_A);
    await engine.appendThread(textFirst.personId, { role: "user", content: "text message", channel: "text" });
    workos.addUser(
      { id: "user_mergekey_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "mergekey-code-001",
    );
    const emailSigned = await service.completeEmailSignIn("mergekey-code-001");
    const req = await codes.requestCodeForTest(PHONE_A);
    await service.verifyPhoneForSession(emailSigned.sessionToken, PHONE_A, req!.code);
    const { previewId, preview } = await service.previewMerge(emailSigned.sessionToken, textFirst.personId);
    return { ...ctx, textFirst, emailSigned, previewId, preview };
  }

  it("the same key twice merges once", async () => {
    const { service, emailSigned, previewId, engine, textFirst } = await mergedSetup();
    const first = await service.confirmMerge(emailSigned.sessionToken, previewId, true, "merge-key-abc");
    expect(first.identities.map((i) => i.kind)).toContain("phone");
    const counts = await engine.getDataCounts(emailSigned.personId);
    expect(counts.conversationMessages).toBe(1);
    // Retry with the same key replays success without duplicating.
    const second = await service.confirmMerge(emailSigned.sessionToken, previewId, true, "merge-key-abc");
    expect(second.personId).toBe(emailSigned.personId);
    const again = await engine.getDataCounts(emailSigned.personId);
    expect(again.conversationMessages).toBe(1);
    void textFirst;
  });

  it("aborts when the account changed since the preview", async () => {
    const { service, emailSigned, previewId, engine, textFirst } = await mergedSetup();
    await engine.appendThread(textFirst.personId, { role: "user", content: "late arrival", channel: "text" });
    await expect(service.confirmMerge(emailSigned.sessionToken, previewId, true, "merge-key-drift")).rejects.toThrow(
      /changed since the preview/,
    );
  });

  it("resumes after an engine failure without duplicating", async () => {
    const { service, emailSigned, previewId, engine, emailSigned: signed } = await mergedSetup();
    let fails = true;
    const origMove = engine.moveData.bind(engine);
    engine.moveData = async (from: string, into: string) => {
      if (fails) throw new Error("engine down");
      return origMove(from, into);
    };
    await expect(service.confirmMerge(signed.sessionToken, previewId, true, "merge-key-resume")).rejects.toThrow(
      /engine down/,
    );
    fails = false;
    const account = await service.confirmMerge(signed.sessionToken, previewId, true, "merge-key-resume");
    expect(account.identities.map((i) => i.kind)).toContain("phone");
    const counts = await engine.getDataCounts(emailSigned.personId);
    expect(counts.conversationMessages).toBe(1);
    expect(counts.documents).toBe(0);
  });
});
