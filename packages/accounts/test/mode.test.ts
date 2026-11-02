import { describe, expect, it } from "vitest";
import { HttpChannels } from "../src/channels";
import { AccountsNotConfiguredError, resolveAccountsMode } from "../src/config";
import { HttpEngineAccounts, parseSessionExpiry } from "../src/engine";

// Item 1: production refuses stand-ins. The live engine client speaks the
// contract the engine follow-up implements; the live channels client speaks
// the code route. Demo mode is explicit.
describe("accounts runtime mode", () => {
  it("runs live when the engine and channels are wired", () => {
    expect(
      resolveAccountsMode({
        NODE_ENV: "production",
        MANO_ENGINE_URL: "https://engine.example",
        MANO_ENGINE_SERVICE_KEY: "sk-test",
        MANO_CHANNELS_URL: "https://channels.example",
        MANO_CHANNELS_KEY: "ck-test",
      }),
    ).toEqual({ mode: "live", engineUrl: "https://engine.example" });
  });

  it("refuses to start in production on stand-ins", () => {
    expect(() => resolveAccountsMode({ NODE_ENV: "production" })).toThrow(AccountsNotConfiguredError);
    // Engine without channels still refuses: codes need the real route.
    expect(() =>
      resolveAccountsMode({
        NODE_ENV: "production",
        MANO_ENGINE_URL: "https://engine.example",
        MANO_ENGINE_SERVICE_KEY: "sk-test",
      }),
    ).toThrow(AccountsNotConfiguredError);
  });

  it("allows an explicit demo mode the UI labels", () => {
    expect(resolveAccountsMode({ NODE_ENV: "production", MANO_ACCOUNTS_DEMO: "1" })).toEqual({ mode: "demo" });
  });

  it("uses stand-ins outside production", () => {
    expect(resolveAccountsMode({ NODE_ENV: "development" })).toEqual({ mode: "stand-in" });
    expect(resolveAccountsMode({})).toEqual({ mode: "stand-in" });
  });
});

describe("live engine client contract", () => {
  function stubFetch(routes: Record<string, unknown>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      const path = new URL(url).pathname;
      if (!(path in routes)) return new Response("nope", { status: 404 });
      return Response.json(routes[path]);
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it("mints sessions through the engine route with the service credential", async () => {
    const { fetchFn, calls } = stubFetch({ "/api/accounts/sessions": { sessionToken: "v1.test.sig" } });
    const engine = new HttpEngineAccounts({
      baseUrl: "https://engine.example",
      serviceKey: "sk-test",
      fetchFn,
    });
    expect(engine.live).toBe(true);
    const token = await engine.mintSession("person_1");
    expect(token).toBe("v1.test.sig");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://engine.example/api/accounts/sessions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ personId: "person_1" });
  });

  it("moves data with the merge idempotency key", async () => {
    const { fetchFn, calls } = stubFetch({ "/api/accounts/move": { ok: true } });
    const engine = new HttpEngineAccounts({ baseUrl: "https://engine.example/", serviceKey: "sk-test", fetchFn });
    await engine.moveData("person_a", "person_b", "merge-key-1");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      fromPersonId: "person_a",
      intoPersonId: "person_b",
      idempotencyKey: "merge-key-1",
    });
  });

  it("maps engine failures to one safe message", async () => {
    const { fetchFn } = stubFetch({});
    const engine = new HttpEngineAccounts({ baseUrl: "https://engine.example", serviceKey: "sk-test", fetchFn });
    await expect(engine.getThread("person_1")).rejects.toThrow(/unavailable/);
  });

  it("reads expiry from engine v1 tokens, null for stand-ins", () => {
    const payload = Buffer.from(JSON.stringify({ kind: "person", sub: "p", exp: 1_800_000_000 })).toString(
      "base64url",
    );
    expect(parseSessionExpiry(`v1.${payload}.sig`)).toBe(1_800_000_000_000);
    expect(parseSessionExpiry("v1.standin.person_1.3")).toBeNull();
    expect(parseSessionExpiry("garbage")).toBeNull();
  });
});

describe("live channels client", () => {
  it("sends codes through the channels code route", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const channels = new HttpChannels("https://channels.example", "ck-test", fetchFn);
    await channels.sendCode("+15550100111", "Your Mano code is 123456. It expires in 10 minutes.");
    expect(calls[0].url).toBe("https://channels.example/internal/send-code");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ck-test");
  });
});
