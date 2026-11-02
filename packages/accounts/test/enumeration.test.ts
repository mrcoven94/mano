import { describe, expect, it } from "vitest";
import { PHONE_A, PHONE_B, testSetup } from "./helpers";

// Item 6: code sends never reveal whether a phone has an account. Unknown
// phones get a real code too; verifying it signs in (creating the account,
// text-first) or links. The observable response and timing shape match.
describe("enumeration-safe code sends", () => {
  it("unknown phones get the same response and a real send", async () => {
    const { service, channels, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    const known = await service.requestPhoneCode(PHONE_A);
    const unknown = await service.requestPhoneCode(PHONE_B);
    expect(known).toEqual({ ok: true });
    expect(unknown).toEqual({ ok: true });
    await codes.flushSends();
    const to = channels.sends.map((s) => s.toE164);
    expect(to).toContain(PHONE_A);
    expect(to).toContain(PHONE_B);
  });

  it("verifying a code on an unknown phone creates the account", async () => {
    const { service, channels, codes } = testSetup();
    await service.requestPhoneCode(PHONE_B);
    await codes.flushSends();
    const last = channels.sends[channels.sends.length - 1];
    const code = last.message.match(/(\d{6})/)?.[1];
    expect(code).toBeTruthy();
    const signed = await service.verifyPhoneCode(PHONE_B, code!);
    expect(signed.personId).toBeTruthy();
    const account = await service.getAccount(signed.sessionToken);
    expect(account.identities.map((i) => i.kind)).toContain("phone");
  });

  it("known and unknown phones share response and timing shape", async () => {
    const { service, codes } = testSetup();
    await service.routeTextHandle("phone", PHONE_A);
    // Warm up so one-time setup cannot skew either side.
    await service.requestPhoneCode(PHONE_A);
    await codes.flushSends();
    const samples: { known: number[]; unknown: number[] } = { known: [], unknown: [] };
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r1 = await service.requestPhoneCode(PHONE_A);
      samples.known.push(Date.now() - t0);
      const t1 = Date.now();
      const r2 = await service.requestPhoneCode("+15550100333");
      samples.unknown.push(Date.now() - t1);
      expect(r1).toEqual(r2);
    }
    await codes.flushSends();
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Same code path, so means stay in the same band. Generous bound: this
    // guards against a missing send or lookup on one side, not nanoseconds.
    expect(mean(samples.unknown)).toBeLessThan(mean(samples.known) + 500);
    expect(mean(samples.known)).toBeLessThan(mean(samples.unknown) + 500);
  });

  it("keeps the global cap", async () => {
    const { PhoneCodeService } = await import("../src/codes");
    const { TEST_PEPPER } = await import("./helpers");
    const capped = new PhoneCodeService({ pepper: TEST_PEPPER, globalCapPerHour: 2 });
    const sends: string[] = [];
    const send = async (to: string) => {
      sends.push(to);
    };
    await capped.requestCode("+15550100401", send);
    await capped.requestCode("+15550100402", send);
    await capped.requestCode("+15550100403", send);
    await capped.flushSends();
    expect(sends).toHaveLength(2);
  });
});
