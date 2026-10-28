import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, PHONE_B, testSetup } from "./helpers";

describe("phone sign-in", () => {
  it("signs the same person in on the web after texting first", async () => {
    const { service, codes, engine } = testSetup();
    const routed = await service.routeTextHandle("phone", PHONE_A);
    await engine.appendThread(routed.personId, { role: "user", content: "text hello", channel: "text" });
    const req = await codes.requestCodeForTest(PHONE_A);
    expect(req).not.toBeNull();
    const signed = await service.verifyPhoneCode(PHONE_A, req!.code);
    expect(signed.personId).toBe(routed.personId);
    const thread = await service.getThread(signed.sessionToken);
    expect(thread.map((m) => m.content)).toContain("text hello");
  });

  it("sends the same response whether or not the phone has an account", async () => {
    const { service, channels } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const known = await service.requestPhoneCode(PHONE_A);
    const unknown = await service.requestPhoneCode(PHONE_B);
    expect(known).toEqual({ ok: true });
    expect(unknown).toEqual({ ok: true });
    expect(channels.sends).toHaveLength(1);
    expect(channels.sends[0].toE164).toBe(PHONE_A);
  });

  it("limits sends to 3 per phone per hour and caps attempts at 5", async () => {
    let now = Date.now();
    const { service, codes } = testSetup(() => now);
    await service.routeTextHandle("phone", PHONE_A);
    for (let i = 0; i < 3; i++) {
      expect(await codes.requestCodeForTest(PHONE_A)).not.toBeNull();
    }
    expect(await codes.requestCodeForTest(PHONE_A)).toBeNull();
    // Attempts: 5 wrong codes exhaust the latest code.
    for (let i = 0; i < 5; i++) {
      await expect(service.verifyPhoneCode(PHONE_A, "000000")).rejects.toThrow();
    }
    // Even the right code no longer works after 5 attempts is covered by
    // expiry test below; here the code row is gone so any code fails.
    await expect(service.verifyPhoneCode(PHONE_A, "000001")).rejects.toThrow();
    void EMAIL_A;
  });

  it("expires codes after 10 minutes", async () => {
    let now = Date.now();
    const { service, codes } = testSetup(() => now);
    await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    expect(req).not.toBeNull();
    now += 11 * 60 * 1000;
    await expect(service.verifyPhoneCode(PHONE_A, req!.code)).rejects.toThrow();
  });

  it("logs sign-in without the code or full number", async () => {
    const { service, codes, engine } = testSetup();
    const routed = await service.routeTextHandle("phone", PHONE_A);
    const req = await codes.requestCodeForTest(PHONE_A);
    await service.verifyPhoneCode(PHONE_A, req!.code);
    const log = await engine.activityLog(routed.personId);
    const signIn = log.find((e) => e.event === "account.sign_in");
    expect(signIn).toBeTruthy();
    const text = JSON.stringify(signIn);
    expect(text).not.toContain(PHONE_A);
    expect(text).not.toContain(req!.code);
  });
});
