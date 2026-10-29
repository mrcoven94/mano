import { describe, expect, it } from "vitest";
import { DeleteIncompleteError } from "../src/service";
import { EMAIL_A, PHONE_A, PHONE_B, testSetup } from "./helpers";

// Item 7: WorkOS IDs and emails rest encrypted; delete removes them for
// real; delete-account is a recorded, retryable job across engine and
// channels.
describe("identity data at rest", () => {
  it("keeps workos ids and emails encrypted in the store", async () => {
    const { service, workos, codes, store } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    workos.addUser(
      { id: "user_sealed_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "sealed-code-001",
    );
    await service.completeEmailSignIn("sealed-code-001", signed.sessionToken);
    const internals = store as unknown as {
      people: Map<string, unknown>;
      byLookup: Map<string, string>;
      workosLinks: Map<string, unknown>;
    };
    const text = JSON.stringify([
      [...internals.people.entries()],
      [...internals.byLookup.entries()],
      [...internals.workosLinks.entries()],
    ]);
    expect(text).not.toContain("user_sealed_001");
    expect(text).not.toContain(EMAIL_A);
    expect(text).not.toContain(PHONE_A);
    // Reads still decrypt for legitimate use.
    const link = await store.getWorkosLink("user_sealed_001");
    expect(link?.email).toBe(EMAIL_A);
    expect(link?.personId).toBe(signed.personId);
  });

  it("delete removes workos link rows for real", async () => {
    const { service, workos, codes, store } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    workos.addUser(
      { id: "user_sealed_002", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "sealed-code-002",
    );
    await service.completeEmailSignIn("sealed-code-002", signed.sessionToken);
    expect(await store.getWorkosLink("user_sealed_002")).not.toBeNull();
    await service.deleteAccount(signed.sessionToken);
    expect(await store.getWorkosLink("user_sealed_002")).toBeNull();
    expect(await store.findPersonByHandle("phone", PHONE_A)).toBeNull();
    expect(await store.findPersonByHandle("email", EMAIL_A)).toBeNull();
  });
});

describe("delete as a retryable job", () => {
  it("retries after a channels failure without redoing the engine delete", async () => {
    const { service, codes, engine, channels, store } = testSetup();
    const routed = await service.routeTextHandle("phone", PHONE_B);
    const req = await codes.requestCodeForTest(PHONE_B);
    const signed = await service.verifyPhoneCode(PHONE_B, req!.code);
    let engineDeletes = 0;
    const origDelete = engine.deleteData.bind(engine);
    engine.deleteData = async (personId: string) => {
      engineDeletes += 1;
      return origDelete(personId);
    };
    let channelsFails = true;
    const origChannels = channels.deleteConversationsForPerson.bind(channels);
    channels.deleteConversationsForPerson = async (personId: string) => {
      if (channelsFails) throw new Error("channels down");
      return origChannels(personId);
    };
    const failed = await service.deleteAccount(signed.sessionToken).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(DeleteIncompleteError);
    const jobId = (failed as DeleteIncompleteError).jobId;
    expect(jobId).toBeTruthy();
    const partial = service.deleteJobStatus(jobId);
    expect(partial?.engineDone).toBe(true);
    expect(partial?.channelsDone).toBe(false);
    expect(partial?.attempts).toBe(1);
    // The person is still there; the retry can still authenticate.
    expect(store.getPerson(routed.personId)).not.toBeNull();
    channelsFails = false;
    await service.retryDeleteAccount(jobId, signed.sessionToken);
    expect(engineDeletes).toBe(1);
    expect(store.getPerson(routed.personId)).toBeNull();
    expect(channels.deletes).toContain(routed.personId);
    const done = service.deleteJobStatus(jobId);
    expect(done?.engineDone && done?.channelsDone && done?.storeDone).toBe(true);
  });

  it("a retry for another person fails closed", async () => {
    const { service, codes, channels } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const reqA = await codes.requestCodeForTest(PHONE_A);
    const a = await service.verifyPhoneCode(PHONE_A, reqA!.code);
    await service.routeTextHandle("phone", PHONE_B);
    const reqB = await codes.requestCodeForTest(PHONE_B);
    const b = await service.verifyPhoneCode(PHONE_B, reqB!.code);
    const origChannels = channels.deleteConversationsForPerson.bind(channels);
    channels.deleteConversationsForPerson = async () => {
      throw new Error("channels down");
    };
    const failed = await service.deleteAccount(a.sessionToken).then(
      () => null,
      (err: unknown) => err,
    );
    const jobId = (failed as DeleteIncompleteError).jobId;
    await expect(service.retryDeleteAccount(jobId, b.sessionToken)).rejects.toThrow(/not found/);
    await expect(service.retryDeleteAccount("del_missing")).rejects.toThrow(/not found/);
    void origChannels;
  });
});
