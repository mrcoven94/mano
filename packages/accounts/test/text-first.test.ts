import { describe, expect, it } from "vitest";
import { EMAIL_A, PHONE_A, testSetup } from "./helpers";

describe("text first", () => {
  it("auto-creates a person on first text with no sign-up step", async () => {
    const { service, store } = testSetup();
    const first = await service.routeTextHandle("phone", PHONE_A);
    expect(first.created).toBe(true);
    const person = store.getPerson(first.personId);
    expect(person?.identities).toHaveLength(1);
    expect(person?.identities[0].verified).toBe(true);
    const second = await service.routeTextHandle("phone", PHONE_A);
    expect(second.created).toBe(false);
    expect(second.personId).toBe(first.personId);
  });

  it("routes the same handle to the same PersonAgent from then on", async () => {
    const { service, engine } = testSetup();
    const first = await service.routeTextHandle("phone", PHONE_A);
    await engine.appendThread(first.personId, { role: "user", content: "hello", channel: "text" });
    const second = await service.routeTextHandle("phone", PHONE_A);
    expect(second.personId).toBe(first.personId);
    expect(await engine.getThread(first.personId)).toHaveLength(1);
  });

  it("email text handles normalize to lowercase", async () => {
    const { service } = testSetup();
    const first = await service.routeTextHandle("email", EMAIL_A.toUpperCase());
    const second = await service.routeTextHandle("email", EMAIL_A);
    expect(second.personId).toBe(first.personId);
  });
});
