import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, PHONE_B, testSetup } from "./helpers";

describe("account page", () => {
  it("shows masked identities, never raw values", async () => {
    const { service, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    const account = await service.getAccount(signed.sessionToken);
    expect(account.identities).toHaveLength(1);
    expect(account.identities[0].masked).not.toContain(PHONE_A);
    expect(account.identities[0].masked).toContain("11");
  });

  it("the last identity cannot be removed", async () => {
    const { service, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    const account = await service.getAccount(signed.sessionToken);
    await expect(service.removeIdentity(signed.sessionToken, account.identities[0].id)).rejects.toThrow(
      /last identity/,
    );
  });

  it("removing a phone needs a fresh code to that phone", async () => {
    let now = Date.now();
    const { service, codes, workos } = testSetup(() => now);
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    workos.addUser(
      { id: "user_rm_001", email: EMAIL_A, emailVerified: true, firstName: null, lastName: null, organizationId: null },
      "rm-code-001",
    );
    await service.completeEmailSignIn("rm-code-001", signed.sessionToken);
    let account = await service.getAccount(signed.sessionToken);
    expect(account.identities).toHaveLength(3);
    now += 11 * 60 * 1000;
    const phone = account.identities.find((i) => i.kind === "phone");
    await expect(service.removeIdentity(signed.sessionToken, phone!.id)).rejects.toThrow(/fresh code/);
    const fresh = await codes.requestCodeForTest(PHONE_A);
    account = await service.removeIdentity(signed.sessionToken, phone!.id, fresh!.code);
    expect(account.identities.some((i) => i.kind === "phone")).toBe(false);
  });

  it("sign out everywhere revokes every session", async () => {
    const { service, codes, engine } = testSetup();
    const routed = await service.routeTextHandle("phone", PHONE_A);
    const first = await codes.requestCodeForTest(PHONE_A);
    const a = await service.verifyPhoneCode(PHONE_A, first!.code);
    const second = await codes.requestCodeForTest(PHONE_A);
    const b = await service.verifyPhoneCode(PHONE_A, second!.code);
    expect(engine.sessionsFor(routed.personId)).toHaveLength(2);
    await service.signOutEverywhere(a.sessionToken);
    expect(engine.sessionsFor(routed.personId)).toHaveLength(0);
    await expect(service.getAccount(b.sessionToken)).rejects.toThrow(/Signed out/);
  });

  it("delete removes the person, engine data and the Channels conversation", async () => {
    const { service, codes, engine, channels, store } = testSetup();
    const routed = await service.routeTextHandle("phone", PHONE_A);
    await engine.appendThread(routed.personId, { role: "user", content: "bye", channel: "text" });
    const req = await codes.requestCodeForTest(PHONE_A);
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    await service.deleteAccount(signed.sessionToken);
    expect(store.getPerson(routed.personId)).toBeNull();
    expect(channels.deletes).toContain(routed.personId);
    expect(await engine.getThread(routed.personId)).toHaveLength(0);
  });

  it("one thread is shared across text, web and app", async () => {
    const { service, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_B);
    const req = await codes.requestCodeForTest(PHONE_B);
    const signed = await service.verifyPhoneCode(PHONE_B, req!.code);
    await service.appendThread(signed.sessionToken, { role: "user", content: "from text", channel: "text" });
    await service.appendThread(signed.sessionToken, { role: "user", content: "from web", channel: "web" });
    await service.appendThread(signed.sessionToken, { role: "assistant", content: "from app", channel: "app" });
    const thread = await service.getThread(signed.sessionToken);
    expect(thread.map((m) => m.content)).toEqual(["from text", "from web", "from app"]);
    const reply = await service.appendThread(signed.sessionToken, {
      role: "user",
      content: "again",
      channel: "text",
    });
    expect(reply.replyChannel).toBe("text");
  });
});
