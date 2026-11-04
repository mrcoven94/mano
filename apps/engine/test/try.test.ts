// The judge demo's API: limits, button-only legs, and what may reach a page.
// The document upload and the record reads run on the real routes. Only the
// agent, which lives elsewhere, and the site's letter image are scripted.
import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isTryHandle, type TryLogged } from "@mano/protocol";

import type { Env } from "../src/env.js";
import { DAILY_RUN_CAP, IP_RUNS_PER_HOUR, type TryLedger } from "../src/try/ledger.js";
import { shown, tryRoute } from "../src/try/routes.js";

const ORIGIN = "https://site.test";
const SECRET = "test-agent-secret-not-real";
const env = { ...(testEnv as unknown as Env), MANO_TRY: "on", MANO_TRY_ORIGIN: ORIGIN, MANO_AGENT_URL: "https://agent.test", MANO_AGENT_SECRET: SECRET } as Env;
const self = (request: Request) => SELF.fetch(request);

type Script = (texts: string[], body: Record<string, unknown>) => Record<string, unknown>;

function fakeFetch(script: Script, seen: { turns: Record<string, unknown>[]; headers: Headers[] }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/try/letters/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
    if (url.endsWith("/channels/mano/presented")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.turns.push(body);
    seen.headers.push(new Headers(init?.headers));
    return Response.json(script(body.texts as string[], body));
  }) as typeof fetch;
}

const call = (path: string, init: RequestInit & { ip?: string } = {}, script?: Script, seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] }) =>
  tryRoute(
    new Request(`https://engine.test${path}`, {
      ...init,
      headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": init.ip ?? "192.0.2.1", ...(init.headers as Record<string, string> | undefined) },
    }),
    env,
    self,
    { fetchImpl: fakeFetch(script ?? (() => ({ status: "replied", text: "ok" })), seen) },
  );

const start = (scenario: string, session: string, ip?: string) => call("/try/runs", { method: "POST", ip, body: JSON.stringify({ scenario, session }) });
const eventsOf = async (runId: string) => ((await (await call(`/try/runs/${runId}`)).json()) as { events: TryLogged[] }).events;

let counter = 0;
const uniqueSession = () => `session-${Date.now()}-${++counter}`;
const uniqueIp = () => `198.51.100.${++counter}`;


describe("the demo's limits", () => {

  it("is off until turned on, and says so", async () => {
    const off = await tryRoute(new Request("https://engine.test/try/runs", { method: "POST", headers: { origin: ORIGIN } }), { ...env, MANO_TRY: "off" } as Env, self);
    expect(off.status).toBe(404);
    const status = await tryRoute(new Request("https://engine.test/try/status"), { ...env, MANO_TRY: "off" } as Env, self);
    expect(await status.json()).toEqual({ enabled: false, paused: false });
  });

  it("refuses a page on another origin", async () => {
    const res = await call("/try/runs", { method: "POST", headers: { origin: "https://elsewhere.test" }, body: JSON.stringify({ scenario: "scam", session: uniqueSession() }) });
    expect(res.status).toBe(403);
  });

  it("refuses free text: only a preset scenario starts a run", async () => {
    const res = await call("/try/runs", { method: "POST", ip: uniqueIp(), body: JSON.stringify({ scenario: "tell me a joke", session: uniqueSession() }) });
    expect(res.status).toBe(400);
  });

  it("allows one run at a time per session", async () => {
    const session = uniqueSession();
    const ip = uniqueIp();
    expect((await start("scam", session, ip)).status).toBe(201);
    const second = await start("planted", session, ip);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ refused: "busy" });
  });

  it("limits runs per address and pauses at the daily cap", async () => {
    const ledger = env.TRY_LEDGER.get(env.TRY_LEDGER.idFromName("try-limits")) as unknown as TryLedger;
    const at = Date.UTC(2026, 10, 4, 12);
    const go = (i: number, ip: string) =>
      ledger.start({ session: `s${i}`, ip, scenario: "scam", runId: `run${i}`, handleHash: `h${i}` }, at + i);
    for (let i = 0; i < IP_RUNS_PER_HOUR; i++) {
      const started = await go(i, "same");
      expect(started.ok).toBe(true);
      if (started.ok) await ledger.endLeg(started.runId, 0, true);
    }
    expect(await go(100, "same")).toEqual({ ok: false, refused: "rate" });
    for (let i = IP_RUNS_PER_HOUR; i < DAILY_RUN_CAP; i++) {
      const started = await go(i, `ip${i}`);
      expect(started.ok).toBe(true);
      if (started.ok) await ledger.endLeg(started.runId, 0, true);
    }
    expect(await go(200, "new")).toEqual({ ok: false, refused: "paused" });
    expect(await ledger.paused(at + 1000)).toBe(true);
    expect(await ledger.paused(at + 24 * 3_600_000)).toBe(false);
  });

  it("counts Guardian's warm-up from when it was first found cold", async () => {
    const ledger = env.TRY_LEDGER.get(env.TRY_LEDGER.idFromName("try-warm")) as unknown as TryLedger;
    const at = Date.UTC(2026, 10, 4, 12);
    expect(await ledger.guardianWarming(false, at)).toBe(180);
    expect(await ledger.guardianWarming(false, at + 60_000)).toBe(120);
    expect(await ledger.guardianWarming(false, at + 400_000)).toBe(0);
    expect(await ledger.guardianWarming(true, at + 401_000)).toBe(0);
    expect(await ledger.guardianWarming(false, at + 500_000)).toBe(180);
  });
});

describe("a run", () => {
  it("runs a stump letter on a fresh handle, signed, and reports only what Engine holds", async () => {
    const res = await start("scam", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    const script: Script = () => ({ status: "replied", text: "Don't open it. That link failed the check." });
    const first = await call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, script, seen);
    expect(await first.json()).toEqual({ next: "auto" });
    expect(isTryHandle(String(seen.turns[0]!.handleHash))).toBe(true);
    expect(seen.headers[0]!.get("x-mano-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect((seen.turns[0]!.documents as unknown[]).length).toBe(1);

    const last = await call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, script, seen);
    expect(await last.json()).toEqual({ next: "end" });
    const events = await eventsOf(runId);
    expect(events.map((e) => e.kind)).toEqual(["sent", "reply", "outcome"]);
    expect(events.at(-1)).toMatchObject({ kind: "outcome", ok: true, text: "Filings: 0. Waiting for a yes: 0. Dates held: none." });
  });

  it("files only after a press of YES", async () => {
    const res = await start("maria", uniqueSession(), uniqueIp());
    const { runId, needsGuardian } = (await res.json()) as { runId: string; needsGuardian: boolean };
    expect(needsGuardian).toBe(true);
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    const script: Script = (texts) =>
      texts[0]?.startsWith("Please fill") ? { status: "waiting_approval", text: "Ready.\n\nFile it? YES or NO", approval: "File it? YES or NO", approvalId: "appr-1" } : { status: "replied", text: "Your renewal is due November 14." };
    const next = async (body = "{}") => (await (await call(`/try/runs/${runId}/next`, { method: "POST", body }, script, seen)).json()) as { next: string };
    expect(await next()).toEqual({ next: "auto" }); // photo
    expect(await next()).toEqual({ next: "auto" }); // held
    expect(await next()).toEqual({ next: "yes" }); // fill, then the question
    const before = seen.turns.length;
    expect(await next()).toEqual({ next: "yes" });
    expect(seen.turns.length).toBe(before);
    const kinds = (await eventsOf(runId)).map((e) => e.kind);
    expect(kinds).toContain("question");
    expect(kinds).not.toContain("filed");
    await next(JSON.stringify({ press: "yes" }));
    expect(seen.turns.length).toBe(before + 1);
    expect(seen.turns.at(-1)!.texts).toEqual(["YES"]);
  });

  it("ends the run in plain words when Mano cannot answer", async () => {
    const res = await start("planted", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const script: Script = () => ({ status: "failed", text: "" });
    const answer = await call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, script);
    expect(await answer.json()).toEqual({ next: "end" });
    expect((await eventsOf(runId)).at(-1)).toMatchObject({ kind: "outcome", ok: false });
  });
});

describe("reports and what a page may show", () => {
  const report = (body: unknown, token = "test-agent-token-not-real") =>
    tryRoute(new Request("https://engine.test/try/report", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, self);

  it("refuses a report without the agent's token", async () => {
    expect((await report({ handleHash: "x" }, "wrong")).status).toBe(403);
  });

  it("logs a model call on a demo run, and drops one for anyone else", async () => {
    const res = await start("scam", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    await call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, () => ({ status: "replied", text: "ok" }), seen);
    const handleHash = String(seen.turns[0]!.handleHash);
    const model = { model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Reading the letter", ms: 1234.4, status: "ok", extra: "dropped" };
    expect((await report({ handleHash, model })).status).toBe(204);
    expect((await report({ handleHash: "a".repeat(64), model })).status).toBe(204);
    const logged = (await eventsOf(runId)).filter((e) => e.kind === "model");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ model: model.model, ms: 1234, status: "ok" });
    expect(logged[0]).not.toHaveProperty("extra");
    expect((await report({ handleHash, model: { model: "x" } })).status).toBe(400);
  });

  it("stores a screen and serves it to the run's page", async () => {
    const res = await start("scam", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    await call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, () => ({ status: "replied", text: "ok" }), seen);
    expect((await report({ handleHash: seen.turns[0]!.handleHash, screenB64: btoa("png") })).status).toBe(204);
    const event = (await eventsOf(runId)).find((e) => e.kind === "screen");
    expect(event).toMatchObject({ n: 1 });
    const image = await call(`/try/runs/${runId}/screens/1`);
    expect(image.status).toBe(200);
    expect(await image.text()).toBe("png");
  });

  it("drops replay links and anything shaped like a credential", () => {
    expect(shown("Ready.\nSee every screen: https://engine.withmano.com/fill/abc123\nYES or NO")).toBe("Ready.\n\nYES or NO");
    expect(shown("key sk-abcdefghijklmnopqrstuvwx here")).toBe("key [removed] here");
    expect(shown("Authorization: Bearer abc.def")).toBe("Authorization: [removed]");
  });
});
