import { describe, expect, it } from "vitest";
import { consumeOAuthChallenge, issueOAuthChallenge, originAllowed } from "../src/oauth";
import { FetchWorkOS } from "../src/workos";
import { TEST_PEPPER } from "./helpers";

// Item 2: server-generated OAuth state bound to browser + session + intent,
// PKCE, origin check. Forged (planted) state fails.
describe("oauth login guard", () => {
  it("round-trips a fresh challenge for anonymous sign-in", async () => {
    const issued = await issueOAuthChallenge({ sessionToken: null, pepper: TEST_PEPPER });
    expect(issued.state).toBeTruthy();
    expect(issued.codeChallenge).toBeTruthy();
    const consumed = await consumeOAuthChallenge({
      cookieValue: issued.cookieValue,
      returnedState: issued.state,
      sessionToken: null,
      pepper: TEST_PEPPER,
    });
    expect(consumed.linking).toBe(false);
    expect(consumed.codeVerifier).toBeTruthy();
  });

  it("round-trips a linking challenge bound to the session", async () => {
    const issued = await issueOAuthChallenge({ sessionToken: "sess_abc", pepper: TEST_PEPPER });
    const consumed = await consumeOAuthChallenge({
      cookieValue: issued.cookieValue,
      returnedState: issued.state,
      sessionToken: "sess_abc",
      pepper: TEST_PEPPER,
    });
    expect(consumed.linking).toBe(true);
  });

  it("rejects a planted (forged) state", async () => {
    const issued = await issueOAuthChallenge({ sessionToken: null, pepper: TEST_PEPPER });
    await expect(
      consumeOAuthChallenge({
        cookieValue: issued.cookieValue,
        returnedState: "attacker-planted-state",
        sessionToken: null,
        pepper: TEST_PEPPER,
      }),
    ).rejects.toThrow();
  });

  it("rejects a challenge replayed in a different session", async () => {
    const issued = await issueOAuthChallenge({ sessionToken: "sess_abc", pepper: TEST_PEPPER });
    // Attacker session tries to complete the victim's login.
    await expect(
      consumeOAuthChallenge({
        cookieValue: issued.cookieValue,
        returnedState: issued.state,
        sessionToken: "sess_attacker",
        pepper: TEST_PEPPER,
      }),
    ).rejects.toThrow();
    // Anonymous callback for a linking challenge also fails.
    await expect(
      consumeOAuthChallenge({
        cookieValue: issued.cookieValue,
        returnedState: issued.state,
        sessionToken: null,
        pepper: TEST_PEPPER,
      }),
    ).rejects.toThrow();
  });

  it("rejects a tampered cookie and an expired challenge", async () => {
    const issued = await issueOAuthChallenge({ sessionToken: null, pepper: TEST_PEPPER });
    const tampered = issued.cookieValue.slice(0, -4) + "AAAA";
    await expect(
      consumeOAuthChallenge({
        cookieValue: tampered,
        returnedState: issued.state,
        sessionToken: null,
        pepper: TEST_PEPPER,
      }),
    ).rejects.toThrow();
    let now = Date.now();
    const fresh = await issueOAuthChallenge({ sessionToken: null, pepper: TEST_PEPPER, now: () => now });
    now += 11 * 60 * 1000;
    await expect(
      consumeOAuthChallenge({
        cookieValue: fresh.cookieValue,
        returnedState: fresh.state,
        sessionToken: null,
        pepper: TEST_PEPPER,
        now: () => now,
      }),
    ).rejects.toThrow();
    // Missing cookie or state fails closed.
    await expect(
      consumeOAuthChallenge({ cookieValue: null, returnedState: fresh.state, sessionToken: null, pepper: TEST_PEPPER }),
    ).rejects.toThrow();
  });

  it("keeps state and verifier out of the cookie plaintext", async () => {
    const issued = await issueOAuthChallenge({ sessionToken: "sess_abc", pepper: TEST_PEPPER });
    const payload = JSON.parse(Buffer.from(issued.cookieValue.split(".")[0], "base64url").toString());
    const text = JSON.stringify(payload);
    expect(text).not.toContain(issued.state);
    expect(text).not.toContain("sess_abc");
  });
});

describe("oauth origin check", () => {
  it("allows same-origin starts, blocks cross-origin and missing origins", () => {
    expect(originAllowed("https://withmano.com/api/accounts/email/start", "https://withmano.com", null)).toBe(true);
    expect(originAllowed("https://withmano.com/api/accounts/email/start", "https://evil.example", null)).toBe(false);
    expect(originAllowed("https://withmano.com/api/accounts/email/start", null, "https://withmano.com/sign-in")).toBe(
      true,
    );
    expect(originAllowed("https://withmano.com/api/accounts/email/start", null, null)).toBe(false);
    expect(originAllowed("https://withmano.com/api/accounts/email/start", "not-a-url", null)).toBe(false);
  });
});

describe("workos pkce", () => {
  it("sends the challenge on authorize and the verifier on exchange", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Response.json({ user: { id: "user_pkce_1", email: "a@example.com", email_verified: true } });
    }) as typeof fetch;
    const workos = new FetchWorkOS(
      { apiKey: "key", clientId: "client", redirectUri: "https://withmano.com/api/auth/callback" },
      fetchFn,
    );
    const url = new URL(workos.authorizationUrl("state-1", "authkit", { codeChallenge: "challenge-1" }));
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    await workos.authenticateWithCode("code-1", { codeVerifier: "verifier-1" });
    expect(JSON.parse(calls[0].init.body as string).code_verifier).toBe("verifier-1");
  });
});
