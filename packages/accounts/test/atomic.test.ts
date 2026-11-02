import { describe, expect, it } from "vitest";
import { PersonStore } from "../src/store";
import { PHONE_A, TEST_KEK_B64, TEST_PEPPER, testSetup } from "./helpers";

// Item 5: code redemption and identity claims are atomic. Parallel attempts
// let exactly one win.
describe("atomic redemption and claims", () => {
  it("parallel redemptions of one code let exactly one win", async () => {
    const { codes } = testSetup();
    const req = await codes.requestCodeForTest(PHONE_A);
    expect(req).not.toBeNull();
    const results = await Promise.all([
      codes.verifyCode(PHONE_A, req!.code),
      codes.verifyCode(PHONE_A, req!.code),
      codes.verifyCode(PHONE_A, req!.code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("parallel identity claims on one person insert exactly one row", async () => {
    const store = new PersonStore({ pepper: TEST_PEPPER, kekB64: TEST_KEK_B64 });
    const a = await store.createPersonWithVerifiedHandle("phone", PHONE_A);
    // Same-person re-add is idempotent, but the rows must not double.
    await Promise.all([
      store.addVerifiedIdentity(a.person.id, "email", "synthetic-race-001@example.com"),
      store.addVerifiedIdentity(a.person.id, "email", "synthetic-race-001@example.com"),
    ]);
    const person = store.getPerson(a.person.id);
    expect(person!.identities.filter((i) => i.kind === "email")).toHaveLength(1);
  });

  it("parallel claims across two people let exactly one win", async () => {
    const store = new PersonStore({ pepper: TEST_PEPPER, kekB64: TEST_KEK_B64 });
    const a = await store.createPersonWithVerifiedHandle("phone", PHONE_A);
    const b = await store.createPersonWithVerifiedHandle("phone", "+15550100999");
    const results = await Promise.allSettled([
      store.addVerifiedIdentity(a.person.id, "email", "synthetic-race-002@example.com"),
      store.addVerifiedIdentity(b.person.id, "email", "synthetic-race-002@example.com"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
