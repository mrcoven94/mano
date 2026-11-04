import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkerSetting, gatewayChecker } from "../src/gateway/index.js";
import type { CheckInput } from "../src/gateway/index.js";
import { healthOk, liveStatus } from "../src/index.js";
import type { TryEvent } from "@mano/protocol";
import type { Env } from "../src/env.js";

// Guardian's client inside workerd: production throws "Illegal invocation"
// for a fetch called off globalThis, and a timeout must come back as
// Guardian's plain reason, not a hang or the gateway's generic one.

const GUARDIAN = {
  MANO_GUARDIAN_URL: "https://guardian.test/check",
  MANO_GUARDIAN_TOKEN: "guardian-token-not-real",
  MANO_GUARDIAN_KEY_ID: "modal-key-not-real",
  MANO_GUARDIAN_KEY_SECRET: "modal-secret-not-real",
};

const INPUT: CheckInput = {
  action: { type: "submit", recipient: "sandbox-agency-portal", purpose: "renewal", payload: {}, documentHash: null },
  sources: [],
  consents: [],
  origin: "person",
};

function installStrictFetch(handler: (body: string, signal: AbortSignal | undefined) => Promise<Response>): void {
  function strictFetch(this: unknown, _input: unknown, init?: RequestInit): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    return handler(String(init?.body), init?.signal ?? undefined);
  }
  vi.stubGlobal("fetch", strictFetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Guardian in workerd", () => {
  it("reports local rules on /health when no Guardian URL is set", async () => {
    const body = (await (await SELF.fetch("https://mano.test/health")).json()) as { ok: boolean; live: { checker: string } };
    expect(body.ok).toBe(true);
    expect(body.live.checker).toBe("local-rules");
  });

  it("reports guardian when set up, and ok:false when half set up", () => {
    const base = env as unknown as Env;
    expect(liveStatus({ ...base, ...GUARDIAN }).checker).toBe("guardian");
    expect(healthOk({ ...base, ...GUARDIAN })).toBe(true);
    const half = { ...base, ...GUARDIAN, MANO_GUARDIAN_TOKEN: "" };
    expect(liveStatus(half).checker).toBe("guardian-misconfigured");
    expect(healthOk(half)).toBe(false);
    expect(JSON.stringify(liveStatus({ ...base, ...GUARDIAN }))).not.toContain("guardian-token-not-real");
  });

  it("checks through the bound default fetch", async () => {
    installStrictFetch(async (body) =>
      body === '{"warm":true}'
        ? Response.json({ warming: true, ready: true }, { status: 202 })
        : Response.json({ verdict: "fix", problems: ["Add the month."] }),
    );
    const { checker } = gatewayChecker(checkerSetting(GUARDIAN));
    expect(await checker!.check(INPUT)).toEqual({ verdict: "fix", problems: ["Add the month."] });
  });

  it("turns a timeout into Guardian's plain reason", async () => {
    installStrictFetch(
      (body, signal) =>
        body === '{"warm":true}'
          ? Promise.resolve(Response.json({ warming: true, ready: false }, { status: 202 }))
          : new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    );
    const { checker, checkerTimeoutMs } = gatewayChecker(checkerSetting(GUARDIAN), { timeoutMs: 50 });
    expect(checkerTimeoutMs).toBeGreaterThan(50);
    const result = await checker!.check(INPUT);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/taking longer than usual.*try again in a few minutes/);
  });
});

describe("what Guardian's checker reports for the judge demo", () => {
  const answer = (id: string) =>
    Response.json({ verdict: "pass", problems: [], model: { id, revision: "r" }, image: { tag: "t", digest: "d" } });
  const run = async (response: () => Response) => {
    installStrictFetch(async (body) => (body.includes('"warm"') ? Response.json({ ready: true }, { status: 202 }) : response()));
    const events: TryEvent[] = [];
    const { checker } = gatewayChecker(checkerSetting({ ...GUARDIAN } as unknown as Env), { trace: (event) => events.push(event) });
    await checker!.check(INPUT);
    return events;
  };

  it("names the model the server says answered", async () => {
    const events = await run(() => answer("RedHatAI/Muse-Glimmer-30B-FP8-block"));
    expect(events[0]).toMatchObject({ kind: "model", model: "RedHatAI/Muse-Glimmer-30B-FP8-block", where: "Our GPU on Modal", state: "live", status: "200" });
    expect(events[1]).toMatchObject({ kind: "guardian", verdict: "pass", state: "live" });
  });

  it("marks a stand-in as a stand-in, on the call and the verdict", async () => {
    const events = await run(() => answer("stand-in"));
    expect(events[0]).toMatchObject({ kind: "model", model: "stand-in", where: "No model called", state: "stand-in" });
    expect(events[1]).toMatchObject({ kind: "guardian", verdict: "pass", state: "stand-in" });
  });

  it("names only the address for a call nothing answered", async () => {
    const events = await run(() => new Response(null, { status: 500 }));
    expect(events[0]).toMatchObject({ kind: "model", where: "Our GPU on Modal", state: "live", status: "500" });
  });
});
