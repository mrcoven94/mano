import { describe, expect, it } from "vitest";
import { StandInAccountsDirectory, buildAccountsDirectory, isSignInCode, signInCodeMessage } from "../src/accounts.js";

const PEPPER = "test-pepper-not-real";

describe("accounts directory stand-in", () => {
  it("routes the same handle to the same person", async () => {
    const dir = new StandInAccountsDirectory(PEPPER);
    const first = await dir.resolvePerson("+15550001001");
    const second = await dir.resolvePerson("+15550001001");
    expect(first.personId).toBe(second.personId);
    expect(first.personId.startsWith("person_")).toBe(true);
  });

  it("maps different handles to different people", async () => {
    const dir = buildAccountsDirectory({ MANO_HANDLE_PEPPER: PEPPER });
    const a = await dir.resolvePerson("+15550001001");
    const b = await dir.resolvePerson("+15550001002");
    expect(a.personId).not.toBe(b.personId);
  });
});

describe("sign-in codes", () => {
  it("accepts only six digits", () => {
    expect(isSignInCode("123456")).toBe(true);
    for (const bad of ["12345", "1234567", "abcdef", "12345a", "", " 123456", "123 456", "123456 "]) {
      expect(isSignInCode(bad)).toBe(false);
    }
  });

  it("builds the exact code text", () => {
    expect(signInCodeMessage("123456")).toBe("Your Mano code is 123456. It expires in 10 minutes.");
  });
});
