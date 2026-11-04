// The judge demo's API: limits, button-only legs, and what may reach a page.
// The document upload and the record reads run on the real routes. Only the
// agent, which lives elsewhere, and the site's letter image are scripted.
import { SELF, env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { isTryHandle, mintHandleGrant, personIdForHandle, type TryLogged } from "@mano/protocol";

import type { Env } from "../src/env.js";
import { DAILY_RUN_CAP, GUARDIAN_PROBES_PER_RUN, GUARDIAN_WARM_WINDOW_MS, IP_RUNS_PER_HOUR, LEG_LEASE_MS, MAX_TURNS_PER_RUN, RUN_EXPIRES_MS, type TryLedger } from "../src/try/ledger.js";
import { shown, tryRoute } from "../src/try/routes.js";

const ORIGIN = "https://site.test";
const SECRET = "test-agent-secret-not-real";
const env = { ...(testEnv as unknown as Env), MANO_TRY: "on", MANO_TRY_ORIGIN: ORIGIN, MANO_AGENT_URL: "https://agent.test", MANO_AGENT_SECRET: SECRET } as Env;
const self = (request: Request) => SELF.fetch(request);

type Script = (texts: string[], body: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

function fakeFetch(script: Script, seen: { turns: Record<string, unknown>[]; headers: Headers[] }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/try/letters/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
    if (url.endsWith("/channels/mano/presented")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.turns.push(body);
    seen.headers.push(new Headers(init?.headers));
    return Response.json(await script(body.texts as string[], body));
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

const opened: string[] = [];
const start = async (scenario: string, session: string, ip?: string) => {
  const res = await call("/try/runs", { method: "POST", ip, body: JSON.stringify({ scenario, session }) });
  const { runId } = (await res.clone().json()) as { runId?: string };
  if (runId) opened.push(runId);
  return res;
};

// Runs left open would fill the demo's limit on active runs for later tests.
afterEach(async () => {
  const ledger = env.TRY_LEDGER.get(env.TRY_LEDGER.idFromName("try")) as unknown as TryLedger;
  for (const id of opened.splice(0)) {
    const run = await ledger.run(id);
    if (!run || run.done) continue;
    const owner = await ledger.beginLeg(id, run.leg, 0);
    await ledger.endLeg(id, owner, run.leg, true);
  }
});
const eventsOf = async (runId: string) => ((await (await call(`/try/runs/${runId}`)).json()) as { events: TryLogged[] }).events;

let counter = 0;
const uniqueSession = () => `session-${Date.now()}-${++counter}`;
const uniqueIp = () => `198.51.100.${++counter}`;


async function finish(ledger: TryLedger, runId: string) {
  const owner = await ledger.beginLeg(runId, 0, 0);
  await ledger.endLeg(runId, owner, 0, true);
}

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
      if (started.ok) await finish(ledger, started.runId);
    }
    expect(await go(100, "same")).toEqual({ ok: false, refused: "rate" });
    for (let i = IP_RUNS_PER_HOUR; i < DAILY_RUN_CAP; i++) {
      const started = await go(i, `ip${i}`);
      expect(started.ok).toBe(true);
      if (started.ok) await finish(ledger, started.runId);
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

describe("Guardian's warm-up spends only for a running run", () => {
  const ledgerNamed = (name: string) => env.TRY_LEDGER.get(env.TRY_LEDGER.idFromName(name)) as unknown as TryLedger;
  const at = Date.UTC(2026, 10, 4, 12);
  const open = (ledger: TryLedger, id: string, when = at) => ledger.start({ session: `s-${id}`, ip: `i-${id}`, scenario: "maria", runId: id, handleHash: `h-${id}` }, when);

  it("refuses a finished run and an expired one", async () => {
    const ledger = ledgerNamed("try-guardian-1");
    await open(ledger, "over");
    await finish(ledger, "over");
    expect(await ledger.claimGuardian("over", at + 1)).toBe("refused");
    await open(ledger, "old");
    expect(await ledger.claimGuardian("old", at + RUN_EXPIRES_MS + 1)).toBe("refused");
    expect(await ledger.claimGuardian("nobody", at)).toBe("refused");
  });

  it("wakes at most once per gap, stops after the window and the budget, and not at all once ready", async () => {
    const ledger = ledgerNamed("try-guardian-2");
    await open(ledger, "gap");
    expect(await ledger.claimGuardian("gap", at)).toBe("wake");
    expect(await ledger.claimGuardian("gap", at + 1000)).toBe("wait");
    expect(await ledger.claimGuardian("gap", at + 8001)).toBe("wake");
    expect(await ledger.claimGuardian("gap", at + GUARDIAN_WARM_WINDOW_MS + 1)).toBe("refused");

    await open(ledger, "budget");
    let wakes = 0;
    for (let i = 0; i < GUARDIAN_PROBES_PER_RUN + 5; i++) if ((await ledger.claimGuardian("budget", at + i * 8001)) === "wake") wakes += 1;
    expect(wakes).toBeLessThanOrEqual(GUARDIAN_PROBES_PER_RUN);

    await open(ledger, "up");
    expect(await ledger.claimGuardian("up", at)).toBe("wake");
    await ledger.guardianIsReady("up");
    expect(await ledger.claimGuardian("up", at + 60_000)).toBe("ready");
  });
});

describe("the warm-up route", () => {
  const guarded = { ...env, MANO_GUARDIAN_URL: "https://guardian.test", MANO_GUARDIAN_TOKEN: "t", MANO_GUARDIAN_KEY_ID: "k", MANO_GUARDIAN_KEY_SECRET: "s" } as Env;
  const wake = async (runId: string, counted: { calls: number }, status = 503) => {
    const fetchImpl = (async () => {
      counted.calls += 1;
      return new Response(status === 202 ? JSON.stringify({ ready: true }) : null, { status });
    }) as unknown as typeof fetch;
    const res = await tryRoute(new Request(`https://engine.test/try/runs/${runId}/guardian`, { method: "POST", headers: { origin: ORIGIN } }), guarded, self, { fetchImpl });
    return { status: res.status, body: (await res.json()) as { state: string; secondsLeft: number } };
  };

  it("reaches the GPU once per gap for a running filing, and never for anything else", async () => {
    const maria = ((await (await start("maria", uniqueSession(), uniqueIp())).json()) as { runId: string }).runId;
    const counted = { calls: 0 };
    expect((await wake(maria, counted)).body.state).toBe("starting");
    expect((await wake(maria, counted)).body.state).toBe("starting");
    expect((await wake(maria, counted)).body.state).toBe("starting");
    expect(counted.calls).toBe(1);

    const scam = ((await (await start("scam", uniqueSession(), uniqueIp())).json()) as { runId: string }).runId;
    expect((await wake(scam, counted)).status).toBe(409);
    expect(counted.calls).toBe(1);

    const ended = ((await (await start("planted", uniqueSession(), uniqueIp())).json()) as { runId: string }).runId;
    await call(`/try/runs/${ended}/next`, { method: "POST", body: "{}" }, () => ({ status: "failed", text: "" }));
    expect((await wake(ended, counted)).status).toBe(409);
    expect(counted.calls).toBe(1);
  });
});

describe("a leg's claim", () => {
  const ledgerNamed = (name: string) => env.TRY_LEDGER.get(env.TRY_LEDGER.idFromName(name)) as unknown as TryLedger;
  const at = Date.UTC(2026, 10, 4, 12);
  const open = (ledger: TryLedger, id: string) => ledger.start({ session: `s-${id}`, ip: `i-${id}`, scenario: "maria", runId: id, handleHash: `h-${id}` }, at);

  it("covers the longest leg: five 100-second turns and their reads", () => {
    expect(LEG_LEASE_MS).toBeGreaterThanOrEqual(5 * 100_000 + 2 * 30_000);
    expect(RUN_EXPIRES_MS).toBeGreaterThan(LEG_LEASE_MS + 180_000);
  });

  it("cannot be taken while a long fill runs", async () => {
    const ledger = ledgerNamed("try-leg-1");
    await open(ledger, "fill");
    expect(await ledger.beginLeg("fill", 0, 5, at)).toMatch(/-/);
    expect(await ledger.beginLeg("fill", 0, 5, at + 500_000)).toBe("busy");
    expect(await ledger.beginLeg("fill", 0, 5, at + LEG_LEASE_MS + 1)).toMatch(/-/);
  });

  it("reserves turns with the claim, and ends the run instead of passing the limit", async () => {
    const ledger = ledgerNamed("try-leg-3");
    await open(ledger, "turns");
    let claims = 0;
    for (let i = 0; i < MAX_TURNS_PER_RUN + 5; i++) {
      const owner = await ledger.beginLeg("turns", 0, 1, at + i);
      if (owner === "spent") break;
      claims += 1;
      await ledger.endLeg("turns", owner, 0, false);
    }
    expect(claims).toBe(MAX_TURNS_PER_RUN);
    expect((await ledger.run("turns", at + 100))?.done).toBe(true);
    expect(await ledger.beginLeg("turns", 0, 1, at + 200)).toBe("busy");
  });

  it("ends only for its own owner, and a late end never reopens a finished run", async () => {
    const ledger = ledgerNamed("try-leg-2");
    await open(ledger, "late");
    const first = await ledger.beginLeg("late", 0, 1, at);
    const second = await ledger.beginLeg("late", 0, 1, at + LEG_LEASE_MS + 1);
    expect(await ledger.endLeg("late", first, 1, false)).toBe(false);
    expect((await ledger.run("late", at + LEG_LEASE_MS + 2))?.leg).toBe(0);
    await ledger.appendAs("late", first, { kind: "note", text: "stale" });
    expect(await ledger.read("late", 0)).toEqual([]);
    expect(await ledger.endLeg("late", second, 0, true)).toBe(true);
    expect(await ledger.endLeg("late", first, 1, false)).toBe(false);
    expect((await ledger.run("late", at + LEG_LEASE_MS + 3))?.done).toBe(true);
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

  it("says unverified, not nothing filed, when the record cannot be read after a YES", async () => {
    const res = await start("maria", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const script: Script = (texts) =>
      texts[0]?.startsWith("Please fill") ? { status: "waiting_approval", text: "File it? YES or NO", approval: "File it? YES or NO", approvalId: "appr-1" } : { status: "replied", text: "Done. Sent: renewal. Confirmation SR-1." };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    const press = (body = "{}") => call(`/try/runs/${runId}/next`, { method: "POST", body }, script, seen);
    await press();
    await press();
    await press();
    const down = (request: Request) =>
      new URL(request.url).pathname.endsWith("/approvals") ? Promise.resolve(new Response("{}", { status: 503 })) : self(request);
    const answer = await tryRoute(
      new Request(`https://engine.test/try/runs/${runId}/next`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ press: "yes" }) }),
      env,
      down,
      { fetchImpl: fakeFetch(script, seen) },
    );
    expect(await answer.json()).toEqual({ next: "end" });
    const last = (await eventsOf(runId)).at(-1) as { text: string };
    expect(last.text).toMatch(/unverified/);
    expect(last.text).not.toMatch(/nothing/i);
  });

  it("holds the limit of turns when YES presses queue with unfinished bodies", async () => {
    const res = await start("maria", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const script: Script = (texts) =>
      texts[0]?.startsWith("Please fill") ? { status: "waiting_approval", text: "File it? YES or NO", approval: "File it? YES or NO", approvalId: "appr-1" } : { status: "replied", text: "The safety check is taking a moment, so nothing was sent yet." };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    const press = (body: string | ReadableStream = "{}") =>
      tryRoute(
        new Request(`https://engine.test/try/runs/${runId}/next`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "192.0.2.9" }, body }),
        env,
        self,
        { fetchImpl: fakeFetch(script, seen) },
      );
    await press();
    await press();
    await press();
    const before = seen.turns.length;
    // Every request starts before any body arrives, as a slow or hostile
    // client can arrange, then the bodies arrive one at a time.
    const queued = Array.from({ length: 31 }, () => {
      const { readable, writable } = new TransformStream();
      return { writer: writable.getWriter(), answer: press(readable) };
    });
    const answers: { next: string }[] = [];
    for (const { writer, answer } of queued) {
      await writer.write(new TextEncoder().encode(JSON.stringify({ press: "yes" })));
      await writer.close();
      answers.push((await (await answer).json()) as { next: string });
    }
    expect(seen.turns.length).toBeLessThanOrEqual(MAX_TURNS_PER_RUN);
    expect(seen.turns.length - before).toBeLessThanOrEqual(MAX_TURNS_PER_RUN - 6);
    expect(answers.at(-1)).toEqual({ next: "end" });
    expect(((await eventsOf(runId)).at(-1) as { text: string }).text).toMatch(/unverified/);
  });

  it("waits for a filing that finishes after the turn gave up, and asks again only if it does not", async () => {
    const res = await start("maria", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const script: Script = (texts) =>
      texts[0]?.startsWith("Please fill") ? { status: "waiting_approval", text: "File it? YES or NO", approval: "File it? YES or NO", approvalId: "appr-1" } : { status: "replied", text: "I could not confirm that just now. Reply YES again to retry; it will not be sent twice." };
    const press = (body = "{}") => call(`/try/runs/${runId}/next`, { method: "POST", body }, script);
    await press();
    await press();
    await press();
    // No approval on record in this scripted run, so there is nothing to wait for.
    expect(await (await press(JSON.stringify({ press: "yes" }))).json()).toEqual({ next: "yes" });
    expect((await eventsOf(runId)).some((e) => e.kind === "outcome")).toBe(false);
  });

  // The agent is scripted, and its proposal and approval go to the real routes,
  // so the real gateway decides.
  const agentOnEngine = (): Script => {
    let approvalId = "";
    const route = async (handleHash: string, method: string, path: string, body?: unknown) => {
      const person = personIdForHandle(handleHash);
      return SELF.fetch(`https://engine.test/api/persons/${encodeURIComponent(person)}${path}`, {
        method,
        headers: {
          authorization: "Bearer test-agent-token-not-real",
          "content-type": "application/json",
          "x-mano-handle-grant": await mintHandleGrant(handleHash, "test-handle-grant-secret-not-real"),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    };
    return async (texts, body) => {
      const handleHash = String(body.handleHash);
      if (texts[0]?.startsWith("Please fill")) {
        const res = await route(handleHash, "POST", "/action", {
          type: "submit",
          recipient: "sandbox-agency-portal",
          purpose: "Food benefits renewal",
          payload: { fullName: "Maria Torres" },
          documentId: "try1",
          sources: [{ kind: "document", id: "try1" }],
          idempotencyKey: `test-${crypto.randomUUID()}`,
          actor: "foreground",
          origin: "person",
          generation: 0,
        });
        const out = (await res.json()) as { status: string; approval?: { id: string } };
        expect(out.status).toBe("needs_approval");
        approvalId = out.approval!.id;
        return { status: "waiting_approval", text: "File it? YES or NO", approval: "File it? YES or NO", approvalId };
      }
      if (texts[0] === "YES") {
        const res = await route(handleHash, "POST", `/approvals/${approvalId}/approve`);
        const out = (await res.json()) as { status: string };
        return { status: "replied", text: out.status === "stale" ? "That changed after you saw it, so nothing was sent." : `Answer: ${out.status}` };
      }
      return { status: "replied", text: "Your renewal is due November 14." };
    };
  };

  const toQuestion = async (scenario: string, script: Script) => {
    const res = await start(scenario, uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const press = (body = "{}") => call(`/try/runs/${runId}/next`, { method: "POST", body }, script);
    await press();
    await press();
    await press();
    return { runId, press };
  };

  describe("a scrambled run's claim", () => {
    const withPortal = { ...env, SANDBOX_BASE_URL: "https://portal.test/" } as Env;
    const reportVisit = (handleHash: unknown, visited: string) =>
      tryRoute(new Request("https://engine.test/try/report", { method: "POST", headers: { authorization: "Bearer test-agent-token-not-real", "content-type": "application/json" }, body: JSON.stringify({ handleHash, visited }) }), withPortal, self);

    // visited: the address the agent's computer reports, given the run's own layout.
    const run = async (replay: number, visited: (layoutPath: string) => string | null) => {
      const res = await start("scramble", uniqueSession(), uniqueIp());
      const { runId } = (await res.json()) as { runId: string };
      const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
      const script: Script = async (texts, body) => {
        if (!texts[0]?.startsWith("Please fill")) return { status: "replied", text: "Your renewal is due November 14." };
        const url = String(texts[0].match(/https:\S+/)?.[0]);
        const path = visited(new URL(url).pathname);
        if (path) expect((await reportVisit(body.handleHash, path)).status).toBe(204);
        return { status: "waiting_approval", text: "File it? YES or NO", approval: "File it? YES or NO", approvalId: "appr-1" };
      };
      const engine = (request: Request) => (new URL(request.url).pathname.endsWith("/replay") ? Promise.resolve(new Response("{}", { status: replay })) : self(request));
      for (let i = 0; i < 3; i++) {
        await tryRoute(new Request(`https://engine.test/try/runs/${runId}/next`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), withPortal, engine, { fetchImpl: fakeFetch(script, seen) });
      }
      const events = await eventsOf(runId);
      return { runId, seen, events, fill: events.find((e) => e.kind === "fill") as { text: string; newLayout: boolean } };
    };

    it("gets a layout of its own, on a seed that is not the run's ID", async () => {
      const { runId, seen, events } = await run(404, () => null);
      const { url } = events.find((e) => e.kind === "layout") as { url: string };
      expect(url).toMatch(/^https:\/\/portal\.test\/scramble\/[0-9a-f]{16}\/apply$/);
      expect(url).not.toContain(runId);
      expect(String((seen.turns.at(-1)!.texts as string[])[0])).toContain(url);
    });

    it("claims a new form only when the computer's last address was this run's layout", async () => {
      const { fill } = await run(200, (layout) => layout);
      expect(fill).toEqual(expect.objectContaining({ newLayout: true, text: expect.stringContaining("this run's layout") }));
    });

    it("says standard form when the fill went to the default address, even with a replay", async () => {
      const { fill } = await run(200, () => "/apply");
      expect(fill.newLayout).toBe(false);
      expect(fill.text).toContain("standard form");
    });

    it("does not claim another run's layout", async () => {
      const { fill } = await run(200, () => "/scramble/0000000000000000/apply");
      expect(fill.newLayout).toBe(false);
    });

    it("says it does not know when no address was reported", async () => {
      const { fill } = await run(200, () => null);
      expect(fill.newLayout).toBe(false);
      expect(fill.text).toContain("no record");
    });

    it("says the computer did not fill when no fill was saved, whatever it opened", async () => {
      const { fill } = await run(404, (layout) => layout);
      expect(fill.newLayout).toBe(false);
      expect(fill.text).toContain("did not fill");
    });
  });

  it("runs Mano's reply through the text line's voice guard, and leaves the panel's model names alone", async () => {
    const res = await start("scam", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    await call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, () => ({ status: "replied", text: "That message is a scam \u2014 don't do what it says." }), seen);
    const reply = (await eventsOf(runId)).find((e) => e.kind === "reply") as { text: string };
    expect(reply.text).not.toContain("\u2014");
    expect(reply.text).toContain("scam");
    const report = await tryRoute(
      new Request("https://engine.test/try/report", { method: "POST", headers: { authorization: "Bearer test-agent-token-not-real", "content-type": "application/json" }, body: JSON.stringify({ handleHash: seen.turns[0]!.handleHash, model: { model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Mano's turn", ms: 1, status: "ok", state: "live" } }) }),
      env,
      self,
    );
    expect(report.status).toBe(204);
    expect((await eventsOf(runId)).some((e) => e.kind === "model" && e.model === "meta/muse-spark-open")).toBe(true);
  });

  it("asks again when Mano answers with no question this demo knows", async () => {
    const res = await start("maria", uniqueSession(), uniqueIp());
    const { runId } = (await res.json()) as { runId: string };
    const seen = { turns: [] as Record<string, unknown>[], headers: [] as Headers[] };
    let fills = 0;
    const script: Script = (texts) => {
      if (!texts[0]?.startsWith("Please fill")) return { status: "replied", text: "Your renewal is due November 14." };
      fills += 1;
      return fills === 1 ? { status: "replied", text: "I'm starting your renewal now." } : { status: "waiting_approval", text: "File it? YES or NO", approval: "File it? YES or NO", approvalId: "appr-1" };
    };
    const press = () => call(`/try/runs/${runId}/next`, { method: "POST", body: "{}" }, script, seen);
    await press();
    await press();
    expect(await (await press()).json()).toEqual({ next: "yes" });
    expect(fills).toBe(2);
  });

  it("has the gateway refuse a yes when the document changed after the question", async () => {
    const { runId, press } = await toQuestion("changed", agentOnEngine());
    expect(await (await press(JSON.stringify({ press: "yes" }))).json()).toEqual({ next: "end" });
    const events = await eventsOf(runId);
    expect(events.some((e) => e.kind === "note" && e.text.includes("changed one byte"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "outcome", ok: true, text: expect.stringContaining("Nothing was filed") });
    expect(events.some((e) => e.kind === "filed")).toBe(false);
  });

  it("leaves the document alone on an ordinary run", async () => {
    const { runId, press } = await toQuestion("maria", agentOnEngine());
    await press(JSON.stringify({ press: "yes" }));
    const events = await eventsOf(runId);
    expect(events.some((e) => e.kind === "note" && e.text.includes("changed one byte"))).toBe(false);
    expect(events.at(-1)).not.toMatchObject({ text: expect.stringContaining("document changed") });
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
    const model = { model: "meta/muse-spark-open", where: "OpenRouter, zero retention", purpose: "Reading the letter", ms: 1234.4, status: "ok", state: "live", extra: "dropped" };
    expect((await report({ handleHash, model })).status).toBe(204);
    expect((await report({ handleHash: "a".repeat(64), model })).status).toBe(204);
    const logged = (await eventsOf(runId)).filter((e) => e.kind === "model");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ model: model.model, ms: 1234, status: "ok", state: "live" });
    expect(logged[0]).not.toHaveProperty("extra");
    expect((await report({ handleHash, model: { model: "x" } })).status).toBe(400);
    expect((await report({ handleHash, model: { ...model, state: "maybe" } })).status).toBe(400);
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
