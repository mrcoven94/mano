import { guardReply } from "@mano/persona";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { presentationHash, renderQuestion } from "../agent/lib/pending.js";
import { heldOf, initialSettleState, reduceSettleEvent } from "../agent/lib/settle.js";
import { handlePresented, handleTurn, type AgentTurnInput, type TurnDeps } from "../agent/lib/turn.js";
import remind from "../agent/tools/remind.js";
import fillForm from "../agent/tools/fill_form.js";
import requestsInstruction from "../agent/instructions/requests.js";
import { toolCtx } from "./ctx.js";
import { getPendingPointer } from "../../engine/src/agents/agent-state.js";
import { LocalRulesChecker } from "../../engine/src/gateway/checker.js";
import { UnconfirmedSendError } from "../../engine/src/gateway/types.js";
import { GuardianChecker } from "../../engine/src/gateway/guardian.js";
import { DefiniteFailureError, TimeoutError, type ActionRequest, type CheckOutcome, type Executor } from "../../engine/src/gateway/index.js";
import { ENGINE_AGENT_TOKEN, ENGINE_CHANNELS_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";
import { installFillDouble, screen, uninstallFillDouble } from "./fill-double.js";

const PRESENTATION_VECTOR = "33f67fe9f135d7efc24d4fbe91c1ed3c8bc540adde738809768ff2c8cbdb1245";
const SECRET = "turn-test-secret";
const HANDLE = "e".repeat(64);
const OTHER = "f".repeat(64);
const fields = {
  caseNumber: "WA-SNAP-0042117",
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "253-555-0100",
  householdSize: "3",
  monthlyIncome: "1800",
};

// The person's answers to fill_form, as the model passes them.
function draft(over: Partial<typeof fields> = {}) {
  return { form: "food-renewal", answers: { ...fields, ...over } };
}

let engine: EngineDouble;
let agentCalls: AgentTurnInput[];
const grants = new Map<string, string>();

function signedAt(path: string, body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request(`http://agent.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

// receivedAt: when Channels received the message, signed in the turn.
function turn(turnId: string, text: string, handleHash = HANDLE, generation = 0, receivedAt = Date.now()): Request {
  return signedAt("/channels/mano/turn", {
    turnId,
    generation,
    handleHash,
    grant: grants.get(handleHash),
    receivedAt,
    texts: [text],
    attachmentCount: 0,
  });
}

// Stands in for Eve: the model either answers plainly or, asked to file,
// calls the real draft tool with the same auth the channel passes.
// One run's form calls, each result fed through the real reducer the way
// settleStream reads it from the run's own event stream.
function formRun(turnId: string) {
  const state = initialSettleState(turnId);
  const note = (status: string, output: unknown) =>
    reduceSettleEvent(state, { type: "action.result", data: { status, result: { kind: "tool-result", callId: "c", toolName: "fill_form", output } } });
  return {
    note,
    async call(answers: ReturnType<typeof draft>, ctx: ReturnType<typeof toolCtx>) {
      try {
        note("completed", await fillForm.execute(answers, ctx));
      } catch (err) {
        note("failed", null);
        throw err;
      }
    },
    held: () => heldOf(state),
  };
}

async function fakeAgent(input: AgentTurnInput) {
  agentCalls.push(input);
  if (/renewal/i.test(input.message)) {
    const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs });
    const name = /Claude Testcase/.test(input.message) ? "Claude Testcase" : fields.fullName;
    const householdSize = /household of 4/.test(input.message) ? "4" : fields.householdSize;
    // The voice guard rewrites dashes, so this address cannot be shown word for word.
    const address = /with a dash/.test(input.message) ? "12 Sample Street \u2014 Unit 4, Testville" : fields.address;
    const phone = /my phone is (\S+)/.exec(input.message)?.[1] ?? fields.phone;
    const run = formRun(input.turnId);
    const call = (answers: ReturnType<typeof draft>) => run.call(answers, ctx);
    await call(draft({ fullName: name, address, householdSize, phone }));
    // A correction in the same message: a second call in the same turn.
    const then = /then change the phone to (\S+)/.exec(input.message)?.[1];
    if (then) await call(draft({ fullName: name, address, householdSize, phone: then }));
    // Engine refuses the fence during a same-turn correction.
    const unfenced = /then the fence fails for (\S+)/.exec(input.message)?.[1];
    if (unfenced) {
      const reachable = engine.fetch;
      vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) =>
        /\/approvals\/fence$/.test(new URL(String(url)).pathname) ? new Response("unavailable", { status: 503 }) : reachable(url, init),
      );
      await call(draft({ fullName: name, address, householdSize, phone: unfenced }));
      vi.stubGlobal("fetch", reachable);
    }
    // Engine stumbles during a same-turn correction and the model's turn then fails.
    const stumble = /then Engine stumbles on (\S+)/.exec(input.message)?.[1];
    if (stumble) {
      const reachable = engine.fetch;
      vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) =>
        /\/(turns|reject)$/.test(new URL(String(url)).pathname) ? new Response("unavailable", { status: 503 }) : reachable(url, init),
      );
      await call(draft({ fullName: name, address, householdSize, phone: stumble })).catch(() => undefined);
      vi.stubGlobal("fetch", reachable);
      return { status: "failed" as const, text: "", reason: "failed", held: run.held() };
    }
    return { status: "replied" as const, text: "Your renewal is ready for your yes.", reason: "stop", held: run.held() };
  }
  return { status: "replied" as const, text: `Answer ${agentCalls.length}`, reason: "stop" };
}

function engineClient() {
  return engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch });
}

function deps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return { secret: SECRET, engine: engineClient(), runAgent: fakeAgent, ...overrides };
}

// What the request-status instruction tells the model at the next turn.
async function told(generation = 0): Promise<string> {
  const resolve = (requestsInstruction as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["turn.started"];
  const out = (await resolve({}, toolCtx({ handleHash: HANDLE, turnId: "turn_told000001", grant: grants.get(HANDLE), generation }))) as { content?: string } | null;
  return out?.content ?? "";
}

type Body = { status: string; text: string; approval?: string; approvalId?: string };

// Times out before filing its first post; the portal cannot be asked
// until checkDown is cleared.
class FlakyPortal implements Executor {
  readonly simulated = true;
  posts: ActionRequest[] = [];
  filed = new Map<string, string>();
  checkDown = true;
  // The office refuses every post after the first.
  refuseRetries = false;
  // The office refuses the first post instead of timing out.
  refuseFirst = false;
  async execute(req: ActionRequest) {
    this.posts.push(req);
    if (this.posts.length === 1 && this.refuseFirst) throw new DefiniteFailureError("The office refused it.");
    if (this.posts.length === 1) throw new TimeoutError();
    if (this.refuseRetries) throw new DefiniteFailureError("The office refused it.");
    this.filed.set(req.idempotencyKey, `sim-${this.posts.length}`);
    return { externalId: `sim-${this.posts.length}` };
  }
  async check(key: string): Promise<CheckOutcome> {
    if (this.checkDown) throw new Error("portal unreachable");
    const id = this.filed.get(key);
    return id ? { found: true, externalId: id } : { found: false };
  }
}

// Plays Channels: after a reply carrying an approval question goes out,
// Channels reports the approval ID and the hash of the question it sent.
async function send(request: Request, d = deps(), opts: { present?: boolean } = {}) {
  const copy = request.clone();
  const res = await handleTurn(request, d);
  const body = (await res.json()) as Body;
  if (body.status === "waiting_approval" && opts.present !== false) {
    const sent = JSON.parse(await copy.text());
    await handlePresented(
      signedAt("/channels/mano/presented", {
        handleHash: sent.handleHash,
        approvalId: body.approvalId,
        textHash: presentationHash(body.approval!),
        generation: sent.generation,
        grant: sent.grant,
      }),
      { secret: SECRET, engine: engineClient() },
    );
  }
  // The person reads a reply before answering: their next message reaches
  // Channels strictly after it.
  await new Promise((r) => setTimeout(r, 3));
  return { status: res.status, body };
}

// Channels reporting (or retrying the report of) a question it sent for
// this approval.
async function present(approval: Parameters<typeof renderQuestion>[0] & { id: string }, handleHash = HANDLE, generation = 0) {
  const res = await handlePresented(
    signedAt("/channels/mano/presented", {
      handleHash,
      approvalId: approval.id,
      textHash: presentationHash(renderQuestion(approval)),
      generation,
      grant: grants.get(handleHash),
    }),
    { secret: SECRET, engine: engineClient() },
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; superseded?: boolean } };
}

const sizes = () =>
  engine
    .approvals()
    .map((x) => `${JSON.parse(x.requestJson).payload.householdSize}:${x.status}`)
    .sort();

// The person was shown the question of one draft, then a newer draft
// landed whose question has not reached them, and clearing the old
// pointer failed, so it still names the first question. With screens,
// the newer draft's fill screens are bound through Engine's replay route
// afterwards: fill_form itself stops when the clear fails.
async function replacedQuestion(shownTurn: string, newerTurn: string, opts: { screens?: boolean } = {}) {
  const shown = await send(turn(shownTurn, "Please file my renewal"));
  const newer = await unshownDraft(newerTurn, "4");
  if (opts.screens) {
    const person = engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0);
    const steps = [1, 2].map((n) => ({ caption: `Mano filled in step ${n}.`, png: screen(n), focus: null }));
    expect(await person.bindReplay(newer.id, { labels: { householdSize: "People in household" }, steps })).toMatch(/\/fill\/[0-9a-f]{32}$/);
  }
  return { shown: shown.body, newer };
}

// A newer draft whose question has not reached the person, while
// clearing the pointer to the question they last saw fails.
async function unshownDraft(turnId: string, householdSize: string) {
  const ctx = toolCtx({ handleHash: HANDLE, turnId, grant: grants.get(HANDLE), turnAtMs: Date.now() });
  await engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).putTurn(turnId, new Date().toISOString());
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    /\/pending-approval$/.test(new URL(String(input)).pathname) && init?.method === "DELETE"
      ? new Response("unavailable", { status: 503 })
      : engine.fetch(input, init),
  );
  await Promise.resolve(fillForm.execute(draft({ householdSize }), ctx)).catch(() => undefined);
  vi.stubGlobal("fetch", engine.fetch);
  await new Promise((r) => setTimeout(r, 3));
  return engine.approvals().find((x) => JSON.parse(x.requestJson).payload.householdSize === householdSize)!;
}

beforeEach(async () => {
  engine = new EngineDouble();
  agentCalls = [];
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
  grants.set(HANDLE, await grantFor(HANDLE));
  grants.set(OTHER, await grantFor(OTHER));
  installFillDouble(engine);
});

afterEach(() => {
  uninstallFillDouble();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("approval by text", () => {
  it("question, YES: the exact frozen approval is approved and the action runs once", async () => {
    const ask = await send(turn("turn_ask_000001", "Please file my renewal"));
    expect(ask.status).toBe(200);
    expect(ask.body.text).toContain("Reply YES");
    expect(ask.body.text).toContain("Case number: WA-SNAP-0042117; Full legal name: Rosa Testcase; Date of birth: 1990-02-03; People in household: 3; Monthly income ($): 1800; Mailing address: 12 Sample Street, Testville;");
    expect(engine.approvals()[0].status).toBe("pending");
    expect(engine.executor.calls).toHaveLength(0);

    const yes = await send(turn("turn_yes_000001", "YES"));
    expect(yes.status).toBe(200);
    expect(agentCalls).toHaveLength(1);
    expect(engine.approvals()[0].status).toBe("approved");
    expect(engine.executor.calls).toHaveLength(1);
    expect(engine.executor.calls[0].payload).toMatchObject(fields);
    expect(yes.body.text).toMatch(/simulated/i);
  });

  // A filing's confirmation must land inside Channels' wait, however long the
  // calls before it took.
  it("a YES waits on Engine only as long as the turn can afford, keeping room for the outcome", async () => {
    const wait = async (id: string, turnBudgetMs: number) => {
      await send(turn(`turn_wait_ask_${id}`, "Please file my renewal"));
      const real = AbortSignal.timeout.bind(AbortSignal);
      const waits: number[] = [];
      const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        waits.push(ms);
        return real(ms);
      });
      const yes = await send(turn(`turn_wait_yes_${id}`, "YES"), deps({ turnBudgetMs }));
      spy.mockRestore();
      expect(yes.status).toBe(200);
      return Math.max(...waits);
    };
    expect(await wait("a", 95_000)).toBe(30_000);
    const tight = await wait("b", 40_000);
    expect(tight).toBeGreaterThan(20_000);
    expect(tight).toBeLessThanOrEqual(25_000);
  });

  // LAP-747 follow-up: a correction that does not fit the form is asked
  // again, and the version shown before it can no longer be filed.
  it("a correction that does not fit closes the question shown: YES files nothing until the new version is shown and answered", async () => {
    await send(turn("turn_fix_000001", "Please file my renewal"));
    const [shown] = engine.approvals();
    const fix = await send(turn("turn_fix_000002", "Fix my renewal, my phone is 253-555-01422"));
    expect(fix.body.status).not.toBe("waiting_approval");
    expect(engine.approvals().find((a) => a.id === shown!.id)?.status).toBe("rejected");

    const yes = await send(turn("turn_fixy_00001", "YES"));
    expect(yes.body.text).not.toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(0);

    const fixed = await send(turn("turn_fix_000003", "Fix my renewal, my phone is 253-555-0199"));
    expect(fixed.body.status).toBe("waiting_approval");
    expect(fixed.body.approval).toContain("Phone number: 253-555-0199");
    await send(turn("turn_fixy_00002", "YES"));
    expect(engine.executor.calls).toHaveLength(1);
    expect(engine.executor.calls[0]!.payload.phone).toBe("253-555-0199");
  });

  it("a correction later in the same turn closes that turn's draft: no question goes out, and a YES files nothing", async () => {
    const ask = await send(turn("turn_same_000001", "File my renewal, then change the phone to 253-555-01422"));
    expect(ask.body.status).not.toBe("waiting_approval");
    expect(ask.body.text).not.toContain("Reply YES");
    expect(engine.approvals().map((a) => a.status)).toEqual(["rejected"]);
    await send(turn("turn_same_00000Y", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("while an approved filing is unresolved a correction prepares nothing, and once it settles the correction goes through", async () => {
    const portal = new FlakyPortal();
    engine.filer = portal;
    await send(turn("turn_late_000001", "Please file my renewal"));
    expect((await send(turn("turn_late_00000Y", "YES"))).body.text).toMatch(/checking/i);
    expect(portal.posts).toHaveLength(1);

    const fix = await send(turn("turn_late_000002", "Fix my renewal, my phone is 253-555-0199"));
    expect(fix.body.status).not.toBe("waiting_approval");
    expect(engine.approvals()).toHaveLength(1);
    expect(portal.posts).toHaveLength(1);

    // The portal answers: the first post never arrived, so her YES sends the
    // version she approved, once, under the same key.
    portal.checkDown = false;
    expect((await send(turn("turn_late_0000Y2", "YES"))).body.text).toMatch(/^Done/);
    expect(portal.posts.map((p) => p.idempotencyKey)).toEqual([portal.posts[0]!.idempotencyKey, portal.posts[0]!.idempotencyKey]);

    const fixed = await send(turn("turn_late_000003", "Fix my renewal, my phone is 253-555-0199"));
    expect(fixed.body.status).toBe("waiting_approval");
    expect((await send(turn("turn_late_0000Y3", "YES"))).body.text).toMatch(/^Done/);
    expect(portal.posts.map((p) => p.payload.phone)).toEqual(["253-555-0100", "253-555-0100", "253-555-0199"]);
  });

  it("when Engine cannot close the corrected draft of the same turn, its question is never shown and a YES files nothing", async () => {
    const reachable = engine.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/approvals\/[^/]+\/reject$/.test(String(input)) ? new Response("unavailable", { status: 503 }) : reachable(input, init),
    );
    const ask = await send(turn("turn_same_000003", "File my renewal, then change the phone to 253-555-01422"));
    expect(ask.body.status).not.toBe("waiting_approval");
    expect(ask.body.text).not.toContain("Reply YES");
    // Engine still holds it, so only Mano's own refusal to show it stands between it and a YES.
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);
    vi.stubGlobal("fetch", reachable);
    await send(turn("turn_same_00000Z", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);
  });

  // Review round 14: the first call holds phone 0100, the same-turn
  // correction's fence answers 503. The early exit still cleans up.
  it("a same-turn correction whose fence fails still closes the first draft: no question goes out, and a YES files nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ask = await send(turn("turn_unf_0000001", "File my renewal, then the fence fails for 253-555-0199"));
    expect(ask.body.status).not.toBe("waiting_approval");
    expect(ask.body.text).not.toContain("Reply YES");
    expect(engine.approvals().map((a) => a.status)).toEqual(["rejected"]);
    await send(turn("turn_unf_000000Y", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  // Review round 15: the fence and every reject fail, and the turn is
  // answered by another instance (a fresh module), so the hold-back made in
  // the tool's process is not visible there. The last form call's result
  // decides: it did not end waiting, so nothing is shown.
  it("a same-turn correction whose fence and close both fail shows nothing, even in an instance that never saw the hold-back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reachable = engine.fetch;
    const d = deps({
      runAgent: async (input) => {
        const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs });
        const run = formRun(input.turnId);
        await run.call(draft(), ctx);
        vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) =>
          /\/approvals\/(fence|[^/]+\/reject)$/.test(new URL(String(url)).pathname) ? new Response("unavailable", { status: 503 }) : reachable(url, init),
        );
        await run.call(draft({ phone: "253-555-0199" }), ctx);
        vi.stubGlobal("fetch", reachable);
        return { status: "replied" as const, text: "I could not update that just now.", reason: "stop", held: run.held() };
      },
    });
    vi.resetModules();
    const other = (await import("../agent/lib/turn.js")) as typeof import("../agent/lib/turn.js");
    const body = (await (await other.handleTurn(turn("turn_unf_0000002", "Please file my renewal"), d)).json()) as Body;
    expect(body.status).not.toBe("waiting_approval");
    expect(body.text).not.toContain("Reply YES");
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);
    await new Promise((r) => setTimeout(r, 3));
    await other.handleTurn(turn("turn_unf_00000Y2", "YES"), deps());
    expect(engine.executor.calls).toHaveLength(0);
  });

  // Review round 15: A's fill outlives its turn, so B's stream carries A's
  // result. B's reply never shows A's question.
  it("a form result carried into another turn's stream shows nothing there", async () => {
    const turnA = "turn_carry_00000A";
    await engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).putTurn(turnA, new Date().toISOString());
    const ctxA = toolCtx({ handleHash: HANDLE, turnId: turnA, grant: grants.get(HANDLE), turnAtMs: Date.now() });
    const fromA = (await fillForm.execute(draft(), ctxA)) as { approvalId: string };
    const [a] = engine.approvals();
    expect(fromA.approvalId).toBe(a!.id);

    // The reducer ignores it, and so does the own-turn filter if it got through.
    const carried = formRun("turn_carry_00000B");
    carried.note("completed", fromA);
    expect(carried.held()).toEqual([]);
    const d = deps({ runAgent: async () => ({ status: "replied" as const, text: "Here is your answer.", reason: "stop", held: [a!.id] }) });
    const b = await send(turn("turn_carry_00000B", "What is my deadline?"), d);
    expect(b.body.status).not.toBe("waiting_approval");
    expect(b.body.text).toBe("Here is your answer.");
    await send(turn("turn_carry_0000Y1", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("a correction that throws in a turn that then fails never shows the draft it was correcting, and a YES files nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ask = await send(turn("turn_stum_000001", "File my renewal, then Engine stumbles on 253-555-0199"));
    expect(ask.body.status).not.toBe("waiting_approval");
    expect(ask.body.text).not.toContain("Reply YES");
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);
    await send(turn("turn_stum_00000Y", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  // Review round 6: the hold-back lives only in process memory. After a
  // restart (a fresh module, so nothing is held back), a YES aimed at the
  // question she saw still shows and files nothing it never showed.
  it("after a restart forgets what was held back, a YES aimed at a replaced question still shows and files nothing", async () => {
    await send(turn("turn_rst_00000A", "Please file my renewal"));
    const turnB = "turn_rst_00000B";
    const ctx = toolCtx({ handleHash: HANDLE, turnId: turnB, grant: grants.get(HANDLE), turnAtMs: Date.now() });
    await engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).putTurn(turnB, new Date().toISOString());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/pending-approval$/.test(new URL(String(input)).pathname) && init?.method === "DELETE"
        ? new Response("unavailable", { status: 503 })
        : engine.fetch(input, init),
    );
    await Promise.resolve(fillForm.execute(draft({ householdSize: "4" }), ctx)).catch(() => undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/reject$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init),
    );
    await fillForm.execute(draft({ householdSize: "4", phone: "253-555-01422" }), ctx);
    vi.stubGlobal("fetch", engine.fetch);
    expect(sizes()).toEqual(["3:rejected", "4:pending"]);

    vi.resetModules();
    const restarted = (await import("../agent/lib/turn.js")) as typeof import("../agent/lib/turn.js");
    const res = await restarted.handleTurn(turn("turn_rst_0000Y1", "YES"), deps());
    const body = (await res.json()) as Body;
    expect(body.status).not.toBe("waiting_approval");
    expect(body.text).toBe("The question you answered changed since you saw it, so nothing was sent. Tell me what you want to send.");
    expect(engine.executor.calls).toHaveLength(0);
    expect(sizes()).toEqual(["3:rejected", "4:pending"]);
  });

  it("a replayed YES on a filing the office refused, after the correction was prepared, files nothing", async () => {
    // The office refuses the first post outright.
    const portal = new FlakyPortal();
    portal.refuseFirst = true;
    engine.filer = portal;
    await send(turn("turn_rpl_0000001", "Please file my renewal"));
    const yes = turn("turn_rpl_000000Y", "YES");
    await send(yes.clone());
    expect(portal.posts).toHaveLength(1);

    const fixed = await send(turn("turn_rpl_0000002", "Fix my renewal, my phone is 253-555-0199"));
    expect(fixed.body.status).toBe("waiting_approval");
    // Channels delivers the original YES again.
    const replay = await send(yes);
    expect(replay.body.text).not.toMatch(/^Done/);
    expect(portal.posts).toHaveLength(1);

    expect((await send(turn("turn_rpl_00000Y2", "YES"))).body.text).toMatch(/^Done/);
    expect(portal.posts.map((p) => p.payload.phone)).toEqual(["253-555-0100", "253-555-0199"]);
  });

  // Review round 8: a correction that only asks a question (no newer
  // proposal exists yet) still retires the failed filing, so a replayed
  // YES cannot follow its ledger binding back to the old values.
  it("a correction that comes back as a question retires the failed filing, and a replayed YES files nothing", async () => {
    const portal = new FlakyPortal();
    portal.refuseFirst = true;
    engine.filer = portal;
    await send(turn("turn_ret_0000001", "Please file my renewal"));
    const yes = turn("turn_ret_000000Y", "YES");
    await send(yes.clone());
    expect(portal.posts).toHaveLength(1);

    const fix = await send(turn("turn_ret_0000002", "Fix my renewal, my phone is 253-555-01422"));
    expect(fix.body.status).not.toBe("waiting_approval");
    expect(engine.approvals().map((a) => a.status)).toEqual(["retired"]);
    const replay = await send(yes);
    expect(replay.body.text).not.toMatch(/^Done/);
    expect(portal.posts).toHaveLength(1);
  });

  it("when Engine will not retire the failed filing, nothing new is prepared and Maria is told plainly", async () => {
    const portal = new FlakyPortal();
    portal.refuseFirst = true;
    engine.filer = portal;
    await send(turn("turn_ret_0000003", "Please file my renewal"));
    await send(turn("turn_ret_00000Y2", "YES"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/retire$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init),
    );
    const ctx = toolCtx({ handleHash: HANDLE, turnId: "turn_ret_0000004", grant: grants.get(HANDLE), turnAtMs: Date.now() });
    await engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).putTurn("turn_ret_0000004", new Date().toISOString());
    const out = (await fillForm.execute(draft({ phone: "253-555-0199" }), ctx)) as { status: string; note: string };
    vi.stubGlobal("fetch", engine.fetch);
    expect(out.status).toBe("fill_failed");
    expect(out.note).toMatch(/earlier renewal could not be updated yet, that nothing new was prepared/);
    expect(engine.approvals().map((a) => a.status)).toEqual(["approved"]);
    expect(portal.posts).toHaveLength(1);
  });

  // Review round 8: after a restart, a replay of the preparing turn in
  // which the model answers without calling a tool shows no question,
  // though Engine still lists the draft the first run held.
  it("a replay of the preparing turn with no tool calls after a restart shows nothing, and a YES files nothing", async () => {
    const preparing = turn("turn_rpt_0000001", "Please file my renewal");
    await send(preparing.clone(), deps(), { present: false });
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);

    vi.resetModules();
    const restarted = (await import("../agent/lib/turn.js")) as typeof import("../agent/lib/turn.js");
    const quiet = deps({ runAgent: async () => ({ status: "replied" as const, text: "I am looking into your renewal.", reason: "stop" }) });
    const body = (await (await restarted.handleTurn(preparing, quiet)).json()) as Body;
    expect(body.status).not.toBe("waiting_approval");
    expect(body.text).not.toContain("Reply YES");

    await send(turn("turn_rpt_000000Y", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  // Review round 9: a retired filing whose receipt is recorded later is
  // reported as sent, with its confirmation, to the model and to a
  // replayed YES, never "nothing was sent".
  async function retiredFiling(prefix: string) {
    const portal = new FlakyPortal();
    portal.refuseFirst = true;
    engine.filer = portal;
    await send(turn(`turn_${prefix}_0000001`, "Please file my renewal"));
    const yes = turn(`turn_${prefix}_000000Y`, "YES");
    await send(yes.clone());
    const [old] = engine.approvals();
    const person = personIdFor(HANDLE);
    expect((await engine.gatewayFor(person).retireApproval(old!.id, person)).status).toBe("rejected");
    const record = () =>
      engine.person(person).store.putReceipt({
        id: `r-${prefix}`, idempotencyKey: old!.idempotencyKey, actionType: "submit", recipient: old!.recipient,
        status: "reconciled", externalId: "RECEIVED-1", simulated: true, requestHash: "", createdAt: new Date().toISOString(),
      });
    return { portal, yes, record };
  }

  it("a retired filing whose receipt is later recorded is reported as sent, with its confirmation", async () => {
    const { portal, yes, record } = await retiredFiling("rcp");
    record();
    expect(engine.approvals()[0]!.status).toBe("retired");
    const status = await told();
    expect(status).toContain("it was filed, confirmation RECEIVED-1");
    expect(status).not.toContain("nothing was sent");
    expect((await send(yes)).body.text).toBe("Done. Sent: Food benefits renewal. Confirmation RECEIVED-1. This was a simulated filing.");
    expect(portal.posts).toHaveLength(1);
  });

  // Review round 10: the receipt is recorded between the NO's first read
  // and its reject. The refreshed read wins: it was sent.
  it("a NO whose filing is recorded between its first read and its reject says it was already sent", async () => {
    const { record } = await retiredFiling("rno");
    const racing: typeof fetch = async (input, init) => {
      if (/\/approvals\/[^/]+\/reject$/.test(new URL(String(input)).pathname)) record();
      return engine.fetch(input, init);
    };
    const no = await send(turn("turn_rno_000000N", "NO"), deps({ engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: racing }) }));
    expect(no.body.text).toBe("That one was already sent, so I cannot cancel it. Confirmation RECEIVED-1.");
  });

  // Review round 12: a YES left the filing in progress, and the recovery
  // sweep later filed it. The pointer to its question must not hold every
  // correction at "an earlier submission is still being confirmed".
  it("once recovery files the approved filing, the correction is prepared as a new filing without another YES", async () => {
    const portal = new FlakyPortal();
    engine.filer = portal;
    await send(turn("turn_fil_0000001", "Please file my renewal"));
    const [old] = engine.approvals();
    expect((await send(turn("turn_fil_000000Y", "YES"))).body.text).toMatch(/checking/i);

    portal.checkDown = false;
    const recovered = await engine.gatewayFor(personIdFor(HANDLE)).recoverAttempt(old!.idempotencyKey, new Date(), new Date(Date.now() + 60_000).toISOString());
    expect(recovered?.status).toBe("completed");

    const fixed = await send(turn("turn_fil_0000002", "Fix my renewal, my phone is 253-555-0199"));
    expect(fixed.body.status).toBe("waiting_approval");
    expect(fixed.body.approval).toContain("Phone number: 253-555-0199");
  });

  // Review round 16: a fresh instance retries the preparing turn with the
  // corrected phone. It must not adopt the waiting draft with the old phone.
  async function freshInstance() {
    vi.resetModules();
    const [other, tool, double] = await Promise.all([import("../agent/lib/turn.js"), import("../agent/tools/fill_form.js"), import("./fill-double.js")]);
    double.installFillDouble(engine);
    return { other, retryFill: (input: AgentTurnInput) => {
      const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs, eveTurn: "eve-turn-2" });
      return tool.default.execute(draft({ phone: "253-555-0199" }), ctx);
    } };
  }

  it("a replay in a fresh instance with a corrected value closes the old draft and shows only the new one", async () => {
    const preparing = turn("turn_rep_0000001", "Please file my renewal");
    await send(preparing.clone(), deps(), { present: false });
    const [old] = engine.approvals();
    expect(JSON.parse(old!.requestJson).payload.phone).toBe(fields.phone);

    const { other, retryFill } = await freshInstance();
    const d = deps({
      runAgent: async (input) => {
        const run = formRun(input.turnId);
        run.note("completed", await retryFill(input));
        return { status: "replied" as const, text: "It is ready for your yes.", reason: "stop", held: run.held() };
      },
    });
    const body = (await (await other.handleTurn(preparing, d)).json()) as Body;
    expect(body.status).toBe("waiting_approval");
    expect(body.approval).toContain("Phone number: 253-555-0199");
    expect(body.text).not.toContain(fields.phone);
    expect(engine.approvals().find((a) => a.id === old!.id)?.status).toBe("rejected");

    const fresh = engine.approvals().find((a) => a.id === body.approvalId)!;
    expect((await present(fresh)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 3));
    expect((await send(turn("turn_rep_000000Y", "YES"))).body.text).toMatch(/^Done/);
    expect(engine.executor.calls.map((c) => c.payload.phone)).toEqual(["253-555-0199"]);
  });

  it("when the replay cannot close the old draft, neither version is shown and a YES files nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const preparing = turn("turn_rep_0000002", "Please file my renewal");
    await send(preparing.clone(), deps(), { present: false });
    const { other, retryFill } = await freshInstance();
    const reachable = engine.fetch;
    const d = deps({
      runAgent: async (input) => {
        vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) =>
          /\/reject$/.test(new URL(String(url)).pathname) ? new Response("unavailable", { status: 503 }) : reachable(url, init),
        );
        const run = formRun(input.turnId);
        run.note("completed", await retryFill(input));
        vi.stubGlobal("fetch", reachable);
        return { status: "replied" as const, text: "I could not update that just now.", reason: "stop", held: run.held() };
      },
    });
    const body = (await (await other.handleTurn(preparing, d)).json()) as Body;
    expect(body.status).not.toBe("waiting_approval");
    expect(body.text).not.toContain("Reply YES");
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);
    await new Promise((r) => setTimeout(r, 3));
    await other.handleTurn(turn("turn_rep_00000Y2", "YES"), deps());
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("once recovery settles the approved filing as failed, the correction is prepared without another YES", async () => {
    const portal = new FlakyPortal();
    portal.refuseRetries = true;
    engine.filer = portal;
    await send(turn("turn_rec_0000001", "Please file my renewal"));
    const [old] = engine.approvals();
    await send(turn("turn_rec_000000Y", "YES"));
    expect((await send(turn("turn_rec_0000002", "Fix my renewal, my phone is 253-555-0199"))).body.status).not.toBe("waiting_approval");

    // Recovery finds the first post never arrived, and the office refuses the retry.
    portal.checkDown = false;
    const recovered = await engine.gatewayFor(personIdFor(HANDLE)).recoverAttempt(old!.idempotencyKey, new Date(), new Date(Date.now() + 60_000).toISOString());
    expect(recovered?.status).toBe("blocked");

    const fixed = await send(turn("turn_rec_0000003", "Fix my renewal, my phone is 253-555-0199"));
    expect(fixed.body.status).toBe("waiting_approval");
    portal.refuseRetries = false;
    expect((await send(turn("turn_rec_00000Y2", "YES"))).body.text).toMatch(/^Done/);
    expect(portal.posts.map((p) => p.payload.phone)).toEqual(["253-555-0100", "253-555-0100", "253-555-0199"]);
  });

  // Review round 3: A shown, B persisted while clearing the pointer to A
  // failed, a correction in B's turn that Engine would not let close B,
  // then a YES aimed at A. The answer must not show B.
  it("a draft held back after a correction is never shown, even as the latest after a YES to a replaced question", async () => {
    await send(turn("turn_held_00000A", "Please file my renewal"));
    const turnB = "turn_held_00000B";
    const ctx = toolCtx({ handleHash: HANDLE, turnId: turnB, grant: grants.get(HANDLE), turnAtMs: Date.now() });
    await engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).putTurn(turnB, new Date().toISOString());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/pending-approval$/.test(new URL(String(input)).pathname) && init?.method === "DELETE"
        ? new Response("unavailable", { status: 503 })
        : engine.fetch(input, init),
    );
    await Promise.resolve(fillForm.execute(draft({ householdSize: "4" }), ctx)).catch(() => undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/reject$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init),
    );
    await fillForm.execute(draft({ householdSize: "4", phone: "253-555-01422" }), ctx);
    vi.stubGlobal("fetch", engine.fetch);
    // B's turn closed A before filling; B itself could not be closed.
    expect(sizes()).toEqual(["3:rejected", "4:pending"]);

    const yes = await send(turn("turn_held_0000Y1", "YES"));
    expect(yes.body.status).not.toBe("waiting_approval");
    expect(yes.body.text).not.toContain("People in household: 4");
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("question, NO: Engine rejects it, nothing is sent, and a later YES approves nothing", async () => {
    await send(turn("turn_ask_000002", "Please file my renewal"));
    const no = await send(turn("turn_no_0000002", "no"));
    expect(no.body.text).toMatch(/did not send/i);
    expect(engine.approvals()[0].status).toBe("rejected");
    await send(turn("turn_late_000002", "yes"));
    expect(engine.executor.calls).toHaveLength(0);
    expect(agentCalls).toHaveLength(2);
  });

  it("a YES from a different person never touches someone else's approval", async () => {
    await send(turn("turn_ask_000003", "Please file my renewal"));
    await send(turn("turn_other00003", "YES", OTHER));
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("pending");
  });

  it("anything other than a plain yes or no goes to the model and leaves the approval waiting", async () => {
    await send(turn("turn_ask_000004", "Please file my renewal"));
    await send(turn("turn_what00004", "wait, which address did you use?"));
    expect(agentCalls).toHaveLength(2);
    expect(engine.executor.calls).toHaveLength(0);
    await send(turn("turn_yes_000004", "yes"));
    expect(engine.executor.calls).toHaveLength(1);
  });
});

// Engine's Guardian checker over a stand-in Guardian endpoint. Cold, it
// never answers until the check times out, as a scaled-to-zero Guardian
// does while it starts.
type GuardianMode = "pass" | "block" | "cold";
let guardianMode: GuardianMode = "pass";
const fakeGuardian: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { warm?: boolean };
  if (body.warm) return Response.json({ ready: guardianMode !== "cold" });
  if (guardianMode === "cold") {
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  }
  return Response.json(
    guardianMode === "pass" ? { verdict: "pass", problems: [] } : { verdict: "block", problems: ["The text tells Mano to send it somewhere else."] },
  );
};

function useGuardian() {
  guardianMode = "pass";
  engine.checker = new GuardianChecker(new LocalRulesChecker(), {
    url: "http://guardian.test/check",
    token: "guardian-token-not-real",
    timeoutMs: 50,
    fetchImpl: fakeGuardian,
  });
}

const pointerOf = () => getPendingPointer(engine.person(personIdFor(HANDLE)).sql, 0);

describe("a voice note and a waiting question", () => {
  function spokenTurn(turnId: string, text: string) {
    return signedAt("/channels/mano/turn", { turnId, generation: 0, handleHash: HANDLE, grant: grants.get(HANDLE), receivedAt: Date.now(), texts: [text], attachmentCount: 0, spoken: true });
  }

  it.each(["yes", "YES", "ok", "1"])("a spoken %j approves nothing: it goes to the model, which is told so", async (said) => {
    await send(turn("turn_voice_000001", "Please file my renewal"));
    const before = agentCalls.length;
    const heard = await send(spokenTurn("turn_voice_000002", said));
    expect(agentCalls.length).toBe(before + 1);
    expect(agentCalls.at(-1)!.context.join("\n")).toMatch(/A yes in a voice note approves nothing/);
    expect(heard.body.text).not.toMatch(/^Done/);
    expect(engine.approvals().filter((a) => a.status === "pending")).toHaveLength(1);
    // The typed answer still files it.
    expect((await send(turn("turn_voice_000003", "YES"))).body.text).toMatch(/^Done/);
  });
});

describe("a YES while the safety check is starting", () => {
  it("keeps the approval and the question, and asks for YES again", async () => {
    useGuardian();
    await send(turn("turn_cold_ask001", "Please file my renewal"));
    const asked = pointerOf();
    expect(asked).not.toBeNull();

    guardianMode = "cold";
    const yes = await send(turn("turn_cold_yes001", "YES"));
    expect(yes.body.text).toBe(
      "The safety check is taking a moment, so nothing was sent yet. Reply YES again in a few minutes and I will send it.",
    );
    expect(engine.approvals()[0].status).toBe("pending");
    expect(pointerOf()?.approvalId).toBe(asked?.approvalId);
    expect(engine.executor.calls).toHaveLength(0);
    expect(agentCalls).toHaveLength(1);
  });

  it("files once on a later YES after the safety check answers", async () => {
    useGuardian();
    await send(turn("turn_cold_ask002", "Please file my renewal"));
    guardianMode = "cold";
    await send(turn("turn_cold_yes002", "YES"));
    await send(turn("turn_cold_yes003", "YES"));
    expect(engine.executor.calls).toHaveLength(0);

    guardianMode = "pass";
    const later = await send(turn("turn_cold_yes004", "yes"));
    expect(later.body.text).toMatch(/^Done\. Sent: /);
    expect(engine.approvals()[0].status).toBe("approved");
    expect(engine.executor.calls).toHaveLength(1);
    expect(pointerOf()).toBeNull();

    await send(turn("turn_cold_yes005", "YES"));
    await send(turn("turn_cold_yes004", "yes"));
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a block from the safety check still drops the approval as before", async () => {
    useGuardian();
    await send(turn("turn_cold_ask006", "Please file my renewal"));
    guardianMode = "block";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const yes = await send(turn("turn_cold_yes006", "YES"));
    expect(warn.mock.calls.map(([m]) => String(m))).toContain(JSON.stringify({ type: "mano_yes_refused", status: "blocked", approval: "pending" }));
    warn.mockRestore();
    expect(yes.body.text).toBe("That approval can no longer be used, so nothing was sent. Want me to prepare it again?");
    expect(pointerOf()).toBeNull();
    expect(engine.executor.calls).toHaveLength(0);
  });
});

describe("a YES needs a question Channels confirmed it showed", () => {
  it("a YES before Channels reports the question as shown approves nothing", async () => {
    await send(turn("turn_unshown001", "Please file my renewal"), deps(), { present: false });
    const yes = await send(turn("turn_unshown002", "YES"));
    expect(yes.body.text).toMatch(/haven't shown you/i);
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("pending");
  });

  it("a report with a different text hash, or for another approval, does not count", async () => {
    const ask = await send(turn("turn_unshown003", "Please file my renewal"), deps(), { present: false });
    const report = (approvalId: string | undefined, textHash: string) =>
      handlePresented(
        signedAt("/channels/mano/presented", { handleHash: HANDLE, approvalId, textHash, generation: 0, grant: grants.get(HANDLE) }),
        { secret: SECRET, engine: engineClient() },
      );
    expect((await report(ask.body.approvalId, presentationHash(`${ask.body.approval} changed`))).status).toBe(409);
    expect((await report("another-approval", presentationHash(ask.body.approval!))).status).toBe(409);
    await send(turn("turn_unshown004", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("the hash both sides compute is pinned", () => {
    // packages/channels/test/agent.test.ts pins the same vector.
    expect(presentationHash("Reply YES  to send\nexactly this.")).toBe(PRESENTATION_VECTOR);
  });
});

describe("the approval question reaches the person exactly", () => {
  it("the question survives the text line's voice guard word for word", async () => {
    const ask = await send(turn("turn_exact00001", "Please file my renewal"));
    expect(ask.body.approval).toContain("Full legal name: Rosa Testcase");
    expect(guardReply(ask.body.text).text).toContain(ask.body.approval);
  });

  it("a person named Claude Testcase sees their own name in the question", async () => {
    const ask = await send(turn("turn_exact00004", "Please file my renewal for Claude Testcase"));
    expect(ask.body.approval).toContain("Full legal name: Claude Testcase");
    expect(guardReply(ask.body.text).text).toContain(ask.body.approval);
  });

  it("a draft the text line would alter is never put to a YES", async () => {
    const ask = await send(turn("turn_exact00002", "Please file my renewal, address with a dash"));
    expect(ask.body.text).not.toContain("Reply YES");
    expect(engine.approvals()[0].status).toBe("rejected");
    await send(turn("turn_exact00003", "YES"));
    expect(engine.executor.calls).toHaveLength(0);
  });
});

describe("what the model is told about earlier requests", () => {
  it("after a YES is filed, the next turn knows it was filed, not still waiting", async () => {
    await send(turn("turn_ask_000017", "Please file my renewal"));
    await send(turn("turn_yes_000017", "YES"));
    expect(await told()).toMatch(/approved it and it was filed/i);
    expect(await told()).not.toMatch(/waiting for this person/i);
  });

  it("while a question waits, the model is told the exact question", async () => {
    const ask = await send(turn("turn_ask_000020", "Please file my renewal"));
    expect(await told()).toContain(ask.body.approval);
  });

  it("after a NO, the next turn knows nothing was sent", async () => {
    await send(turn("turn_ask_000018", "Please file my renewal"));
    await send(turn("turn_no_0000018", "NO"));
    expect(await told()).toMatch(/declined/i);
  });
});

describe("uncertain and refused outcomes", () => {
  it("an unknown filing outcome is never reported as nothing sent, and the same approval is reconciled", async () => {
    await send(turn("turn_ask_000010", "Please file my renewal"));
    engine.executor.failNextWithTimeout = true;
    const realCheck = engine.executor.check.bind(engine.executor);
    let checkDown = true;
    engine.executor.check = async (key, personId) => {
      if (checkDown) throw new Error("portal unreachable");
      return realCheck(key, personId);
    };
    const yes = await send(turn("turn_yes_000010", "YES"));
    expect(yes.body.text).toMatch(/checking/i);
    expect(yes.body.text).not.toMatch(/nothing was sent/i);
    await send(turn("turn_ask_000011", "Please file my renewal"));
    expect(engine.approvals()).toHaveLength(1);
    checkDown = false;
    const again = await send(turn("turn_yes_000011", "YES"));
    expect(again.body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a fax Mano could not confirm is said plainly, is not sent again, and closes the question", async () => {
    await send(turn("turn_ask_000060", "Please file my renewal"));
    engine.executor.failNextWithTimeout = true;
    let checks = 0;
    engine.executor.check = async () => {
      checks += 1;
      throw new UnconfirmedSendError("Mano could not confirm this fax went through.");
    };
    const yes = await send(turn("turn_yes_000060", "YES"));
    expect(yes.body.text).toMatch(/could not confirm/i);
    expect(yes.body.text).toMatch(/not send it again/i);
    expect(yes.body.text).not.toMatch(/nothing was sent/i);
    expect(yes.body.text).not.toMatch(/will not be sent twice/i);
    expect(engine.executor.calls).toHaveLength(1);
    const lookups = checks;
    await send(turn("turn_yes_000061", "YES"));
    expect(checks).toBe(lookups);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("once Engine settles an unknown filing on its own, the next YES reports it done", async () => {
    await send(turn("turn_ask_000014", "Please file my renewal"));
    engine.executor.failNextWithTimeout = true;
    const realCheck = engine.executor.check.bind(engine.executor);
    let checkDown = true;
    engine.executor.check = async (key, personId) => {
      if (checkDown) throw new Error("portal unreachable");
      return realCheck(key, personId);
    };
    expect((await send(turn("turn_yes_000014", "YES"))).body.text).toMatch(/checking/i);
    // Engine's recovery sweep reconciles it without the agent.
    checkDown = false;
    const [approval] = engine.approvals();
    await engine.gatewayFor(approval.personId).approveAndExecute(approval.id, approval.personId);
    const yes = await send(turn("turn_yes_000015", "YES"));
    expect(yes.body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a NO is confirmed only when Engine rejects the approval", async () => {
    await send(turn("turn_ask_000012", "Please file my renewal"));
    const [approval] = engine.approvals();
    // The YES went through in Engine but its answer never reached Mano.
    await engine.gatewayFor(approval.personId).approveAndExecute(approval.id, approval.personId);
    const no = await send(turn("turn_no_0000012", "no"));
    expect(no.body.text).not.toMatch(/did not send|nothing left/i);
    expect(no.body.text).toMatch(/already/i);
  });
});

async function deleteConversation(generation: number) {
  const res = await engine.fetch(`${ENGINE_URL}/api/persons/${personIdFor(HANDLE)}/conversation`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ENGINE_CHANNELS_TOKEN}`, "x-mano-handle-grant": grants.get(HANDLE)! },
    body: JSON.stringify({ generation }),
  });
  return (await res.json()) as { removed: Record<string, number | boolean> };
}

describe("after a deletion", () => {
  it("a YES in the new conversation never approves a draft from before the deletion", async () => {
    await send(turn("turn_ask_000013", "Please file my renewal"));
    const { removed } = await deleteConversation(1);
    expect(removed).toMatchObject({ generation: 1, pendingPointerCleared: true, approvalsRejected: 1 });
    await send(turn("turn_yes_000013", "YES", HANDLE, 1));
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("a turn in a newer conversation brings Engine forward when Channels' delete never reached it", async () => {
    await send(turn("turn_ask_000016", "Please file my renewal"));
    const res = await send(turn("turn_new_000016", "hello again", HANDLE, 1));
    expect(res.status).toBe(200);
    expect(engine.approvals()[0].status).toBe("rejected");
    const conversation = await engine.fetch(`${ENGINE_URL}/api/persons/${personIdFor(HANDLE)}/conversation`, {
      headers: { authorization: `Bearer ${ENGINE_AGENT_TOKEN}`, "x-mano-handle-grant": grants.get(HANDLE)! },
    });
    expect(await conversation.json()).toEqual({ generation: 1 });
  });

  it("the new conversation is told nothing about requests from before the deletion", async () => {
    await send(turn("turn_ask_000019", "Please file my renewal"));
    await send(turn("turn_yes_000019", "YES"));
    await deleteConversation(1);
    expect(await told(1)).toBe("");
  });

  it("a turn from before the deletion is refused and writes nothing", async () => {
    await deleteConversation(1);
    const stale = await send(turn("turn_old_000013", "remind me of something", HANDLE, 0));
    expect(stale.status).toBe(409);
    expect(agentCalls).toHaveLength(0);
  });
});

describe("a decision turn is bound to the question it answered", () => {
  it("a replayed YES never approves a draft presented after it", async () => {
    await send(turn("turn_bindA00001", "Please file my renewal"));
    const yes = turn("turn_bindY00001", "YES");
    const first = await send(yes.clone());
    expect(first.body.text).toMatch(/^Done/);
    await send(turn("turn_bindB00001", "Please file my renewal, household of 4"));
    const replay = await send(yes);
    expect(engine.executor.calls).toHaveLength(1);
    expect(replay.body.text).toMatch(/^Done/);
    const pending = engine.approvals().filter((a) => a.status === "pending");
    expect(pending).toHaveLength(1);
  });

  it("a replayed NO never declines a draft presented after it", async () => {
    await send(turn("turn_bindA00002", "Please file my renewal"));
    const no = turn("turn_bindN00002", "NO");
    await send(no.clone());
    await send(turn("turn_bindB00002", "Please file my renewal, household of 4"));
    await send(no);
    expect(engine.approvals().map((a) => a.status).sort()).toEqual(["pending", "rejected"]);
    await send(turn("turn_bindY00002", "YES"));
    expect(engine.executor.calls).toHaveLength(1);
  });
});

describe("ordering against Channels' receive time", () => {
  it("a YES received before the question was shown never approves it", async () => {
    const yesReceivedAt = Date.now() - 60_000;
    await send(turn("turn_early00001", "Please file my renewal"));
    const yes = await send(turn("turn_earlyY0001", "YES", HANDLE, 0, yesReceivedAt));
    expect(yes.body.text).toMatch(/haven't shown you/i);
    expect(engine.executor.calls).toHaveLength(0);
    expect(engine.approvals()[0].status).toBe("pending");
  });

  it("replaying a draft turn finds its own approval and never closes a later one", async () => {
    const aAt = Date.now() - 60_000;
    const a = turn("turn_draftA0001", "Please file my renewal", HANDLE, 0, aAt);
    await send(a.clone());
    await send(turn("turn_draftB0001", "Please file my renewal, household of 4"));
    await send(a);
    const sizes = engine
      .approvals()
      .map((x) => `${JSON.parse(x.requestJson).payload.householdSize}:${x.status}`)
      .sort();
    expect(sizes).toEqual(["3:rejected", "4:pending"]);
  });
});

describe("a slow draft against a newer one", () => {
  // Sol's sequence: B arrives while A is still being prepared. A's report
  // fails, B's question is sent and reported, then A's report is retried.
  function slowA() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      runAgent: async (input) => {
        if (input.turnId === "turn_slowA00001") await gate;
        return fakeAgent(input);
      },
    });
    return { d, release };
  }

  it("the YES files the newest question shown, never the older draft that finished late", async () => {
    const { d, release } = slowA();
    const preparingA = send(turn("turn_slowA00001", "Please file my renewal"), d, { present: false });
    await new Promise((r) => setTimeout(r, 3));
    const b = await send(turn("turn_slowB00001", "Please file my renewal, household of 4"), d);
    expect(b.body.status).toBe("waiting_approval");
    release();
    await preparingA;
    // B's form call fenced the form for its turn (LAP-747), so A's draft,
    // from an older turn, was refused and never held.
    expect(sizes()).toEqual(["4:pending"]);
    const yes = await send(turn("turn_slowY00001", "YES"));
    expect(yes.body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
    expect(sizes()).toEqual(["4:approved"]);
  });

  it("an older draft that finishes after a newer question was shown is refused even while Engine refuses every close", async () => {
    const { d, release } = slowA();
    const preparingA = send(turn("turn_slowA00001", "Please file my renewal"), d, { present: false });
    await new Promise((r) => setTimeout(r, 3));
    await send(turn("turn_slowB00001", "Please file my renewal, household of 4"), d);
    // Engine refuses every close while A finishes, so both drafts still wait.
    const realFetch = engine.fetch;
    const refusing: typeof fetch = async (input, init) =>
      /\/(reject|supersede)$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : realFetch(input, init);
    vi.stubGlobal("fetch", refusing);
    release();
    await preparingA;
    vi.stubGlobal("fetch", engine.fetch);
    expect(sizes()).toEqual(["4:pending"]);
    const yes = await send(turn("turn_slowY00001", "YES"));
    expect(yes.body.text).toMatch(/^Done/);
    expect(sizes()).toEqual(["4:approved"]);
  });

  // Sol's review 7, after PR 81's review: A's report fails, then closing A
  // fails (Engine 503) when B is asked for. B is not filled, so no newer
  // version exists that the person did not see closed.
  it("a correction whose earlier draft cannot be closed prepares nothing new, and the YES approves nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await send(turn("turn_r7A0000001", "Please file my renewal"), deps(), { present: false });
    const refusing: typeof fetch = async (input, init) =>
      /\/(reject|supersede|fence)$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init);
    vi.stubGlobal("fetch", refusing);
    const closing = deps({ engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: refusing }) });
    const b = await send(turn("turn_r7B0000001", "Please file my renewal, household of 4"), closing, { present: false });
    expect(b.body.status).toBe("replied");
    vi.stubGlobal("fetch", engine.fetch);
    expect(sizes()).toEqual(["3:pending"]);
    expect(warn.mock.calls.some(([line]) => /mano_(close|fence)_failed/.test(String(line)))).toBe(true);
    const yes = await send(turn("turn_r7Y0000001", "YES"));
    expect(yes.body.text).toMatch(/haven't shown you/i);
    expect(engine.executor.calls).toHaveLength(0);
    warn.mockRestore();
  });

  it("an older draft is closed before a newer one is filled, so it is never approved even when the cleanup after fails", async () => {
    await send(turn("turn_r7C0000001", "Please file my renewal"), deps(), { present: false });
    const refusing: typeof fetch = async (input, init) =>
      /\/supersede$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init);
    vi.stubGlobal("fetch", refusing);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await send(turn("turn_r7D0000001", "Please file my renewal, household of 4"), deps({ engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: refusing }) }), { present: false });
    vi.stubGlobal("fetch", engine.fetch);
    expect(sizes()).toEqual(["3:rejected", "4:pending"]);
    const older = engine.approvals().find((x) => JSON.parse(x.requestJson).payload.householdSize === "3")!;
    const person = engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0);
    expect((await person.approve(older.id)).status).toBe("blocked");
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("a YES aimed at a replaced question approves nothing and shows no draft that was never shown", async () => {
    await replacedQuestion("turn_r7E0000001", "turn_r7F0000001");
    const yes = await send(turn("turn_r7G0000001", "YES"), deps(), { present: false });
    expect(yes.body.text).toBe("The question you answered changed since you saw it, so nothing was sent. Tell me what you want to send.");
    expect(yes.body.status).not.toBe("waiting_approval");
    expect(engine.executor.calls).toHaveLength(0);
  });

  // Sol's review 8: a replay of A reads Engine's latest proposal, pauses,
  // B becomes latest and is shown, then the replay closes drafts from what
  // it read before the pause.
  it("a paused replay of an older draft turn never closes the newer draft shown meanwhile", async () => {
    const a = turn("turn_r8A0000001", "Please file my renewal");
    await send(a.clone());
    let release: () => void = () => undefined;
    let paused: () => void = () => undefined;
    const reached = new Promise<void>((r) => (paused = r));
    let armed = true;
    const gated: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (armed && (init?.method ?? "GET") === "GET" && /\/approvals$/.test(url.pathname)) {
        armed = false;
        paused();
        await new Promise<void>((r) => (release = r));
      }
      return engine.fetch(input, init);
    };
    vi.stubGlobal("fetch", gated);
    const replay = send(a, deps({ engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: gated }) }));
    await reached;
    const b = await send(turn("turn_r8B0000001", "Please file my renewal, household of 4"));
    expect(b.body.status).toBe("waiting_approval");
    release();
    await replay;
    vi.stubGlobal("fetch", engine.fetch);
    expect(sizes()).toEqual(["3:rejected", "4:pending"]);
    const yes = await send(turn("turn_r8Y0000001", "YES"));
    expect(yes.body.text).toMatch(/^Done/);
    expect(sizes()).toEqual(["3:rejected", "4:approved"]);
  });

  it("a repeated report of the question keeps when it was first shown", async () => {
    await send(turn("turn_rep_A00001", "Please file my renewal"));
    const yesAt = Date.now();
    await new Promise((r) => setTimeout(r, 3));
    expect((await present(engine.approvals()[0])).status).toBe(200);
    const yes = await send(turn("turn_rep_Y00001", "YES", HANDLE, 0, yesAt));
    expect(yes.body.text).toMatch(/^Done/);
  });
});

describe("the question links to the replay of the fill behind it", () => {
  const LINK = /\n\nSee each step Mano took on the form: (http:\/\/engine\.test\/fill\/[0-9a-f]{32})$/;

  it("the link follows the whole question, survives the voice guard, and opens the steps", async () => {
    const ask = await send(turn("turn_link000001", "Please file my renewal"));
    expect(ask.body.status).toBe("waiting_approval");
    const question = ask.body.approval!;
    expect(question).not.toMatch(/https?:/);
    expect(ask.body.text).toContain(`${question}\n\nSee each step`);
    const url = LINK.exec(ask.body.text)?.[1];
    expect(url).toBeDefined();
    const line = `See each step Mano took on the form: ${url}`;
    expect(guardReply(line).text).toBe(line);

    const page = (await engine.replayPageAt(url!))!;
    expect(page.match(/<img /g)).toHaveLength(8);
    expect(page).toContain("This is exactly what Mano will send when you reply YES.");
    // The question still answers with a plain YES.
    expect((await send(turn("turn_link00000Y", "YES"))).body.text).toMatch(/^Done/);
    expect(await engine.replayPageAt(url!)).toContain("You said yes to this version.");
  });

  it("when Engine cannot make the link, the question goes out alone and still works", async () => {
    engine.replayFailure = 503;
    const ask = await send(turn("turn_nolink00001", "Please file my renewal"));
    expect(ask.body.status).toBe("waiting_approval");
    expect(ask.body.text.endsWith(ask.body.approval!)).toBe(true);
    expect(ask.body.text).not.toContain("See each step");
    expect((await send(turn("turn_nolink0000Y", "YES"))).body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a link opened after the person changed an answer says the form changed and shows no old step", async () => {
    const first = await send(turn("turn_chg_A00001", "Please file my renewal"));
    const oldUrl = LINK.exec(first.body.text)![1]!;
    const second = await send(turn("turn_chg_B00001", "Please file my renewal, household of 4"));
    const newUrl = LINK.exec(second.body.text)![1]!;
    expect(newUrl).not.toBe(oldUrl);

    const old = (await engine.replayPageAt(oldUrl))!;
    expect(old).toContain("This form changed");
    expect(old).not.toContain("<img");
    expect(old).not.toContain("Rosa Testcase");
    expect(await engine.replayPageAt(newUrl)).toContain("<dt>People in household</dt><dd>4</dd>");
  });

  it("a link opened after the attached document changed says so, and the YES is refused as stale", async () => {
    const ask = await send(turn("turn_doc_A00001", "Please file my renewal"));
    const url = LINK.exec(ask.body.text)![1]!;
    engine.documents.set("doc-proof", "%PDF-1.4 synthetic pay stub, edited");
    const page = (await engine.replayPageAt(url))!;
    expect(page).toContain("This form changed");
    expect(page).not.toContain("<img");
    const yes = await send(turn("turn_doc_Y00001", "YES"));
    expect(yes.body.text).not.toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(0);
  });
});

describe("the replay link of a replaced question", () => {
  it("Engine answers no link once the approval was replaced, decided, or expired", async () => {
    const link = (id: string) => engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).replayLink(id);
    const { newer } = await replacedQuestion("turn_rsh_E00001", "turn_rsh_F00001", { screens: true });
    const older = engine.approvals().find((x) => x.id !== newer.id)!;
    expect(older.status).toBe("rejected");
    expect(await link(older.id)).toBeNull();
    expect(await link(newer.id)).toMatch(/\/fill\/[0-9a-f]{32}$/);

    const realNow = engine.now;
    engine.now = () => Date.parse(newer.expiresAt) + 1;
    expect(await link(newer.id)).toBeNull();
    engine.now = realNow;

    expect((await engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).approve(newer.id)).status).toBe("completed");
    expect(await link(newer.id)).toBeNull();
  });
});

describe("a decision that decided nothing, and a NO Engine refused", () => {
  it("a replayed NO that decided nothing never touches a draft created after it", async () => {
    const no = turn("turn_none000001", "NO");
    await send(no.clone());
    await send(turn("turn_noneB00001", "Please file my renewal"));
    await send(no);
    expect(engine.approvals().map((a) => a.status)).toEqual(["pending"]);
  });

  it("a replayed NO that Engine still refuses says it is unsure and keeps the approval tracked", async () => {
    await send(turn("turn_refA000001", "Please file my renewal"));
    const realFetch = engine.fetch;
    const refusing: typeof fetch = async (input, init) =>
      /\/reject$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : realFetch(input, init);
    engine.fetch = refusing;
    vi.stubGlobal("fetch", refusing);
    const d = deps({ engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: refusing }) });
    const no = turn("turn_refN000001", "NO");
    const first = await send(no.clone(), d);
    expect(first.body.text).not.toMatch(/nothing left mano|did not send it/i);
    const replay = await send(no, d);
    expect(replay.body.text).not.toMatch(/nothing left mano|did not send it/i);
    expect(replay.body.text).toMatch(/could not confirm/i);
    expect(engine.approvals()[0].status).toBe("pending");
  });
});

describe("turn replay and recovery", () => {
  it("a replayed turn converges: one reminder, and a replayed YES files once", async () => {
    const remindTurn = turn("turn_rem_000001", "remind me");
    const reminding = deps({
      runAgent: async (input) => {
        agentCalls.push(input);
        const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, turnAtMs: input.turnAtMs });
        await remind.execute({ text: "call the county office", when: "in 2 minutes" }, ctx);
        return { status: "replied", text: "Set.", reason: "stop" };
      },
    });
    await send(remindTurn.clone(), reminding);
    await send(remindTurn, reminding);
    expect(engine.remindersOf(personIdFor(HANDLE))).toHaveLength(1);

    await send(turn("turn_ask_000005", "Please file my renewal"));
    const yes = turn("turn_yes_000005", "YES");
    await send(yes.clone());
    const replay = await send(yes);
    expect(replay.body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("a turn that failed after setting a reminder, retried later, still makes one reminder", async () => {
    let now = Date.parse("2026-10-30T15:00:00Z");
    let attempt = 0;
    const flaky = deps({
      now: () => now,
      runAgent: async (input) => {
        attempt += 1;
        const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, turnAtMs: input.turnAtMs });
        await remind.execute({ text: "call the county office", when: "in 2 minutes" }, ctx);
        if (attempt === 1) throw new Error("model call failed after the tool ran");
        return { status: "replied", text: "Set.", reason: "stop" };
      },
    });
    const first = await send(turn("turn_flaky00001", "Remind me in 2 minutes to call the county office."), flaky);
    expect(first.status).toBe(502);
    now += 60_000;
    const retry = await send(turn("turn_flaky00001", "Remind me in 2 minutes to call the county office."), flaky);
    expect(retry.status).toBe(200);
    expect(engine.remindersOf(personIdFor(HANDLE))).toHaveLength(1);
  });

  it("a turn without a signed turn ID or grant is rejected", async () => {
    const noId = await send(signedAt("/channels/mano/turn", { handleHash: HANDLE, generation: 0, grant: grants.get(HANDLE), texts: ["hello"], attachmentCount: 0 }));
    expect(noId.status).toBe(400);
    const noGrant = await send(signedAt("/channels/mano/turn", { turnId: "turn_nogrant0001", generation: 0, handleHash: HANDLE, texts: ["hello"], attachmentCount: 0 }));
    expect(noGrant.status).toBe(400);
    expect(agentCalls).toHaveLength(0);
  });

  it("refuses to run without Engine", async () => {
    const res = await send(turn("turn_noengine01", "hello"), deps({ engine: null }));
    expect(res.status).toBe(503);
    expect(agentCalls).toHaveLength(0);
  });
});

describe("Guardian warm-up", () => {
  it("warms Guardian when a conversation starts, not on every turn", async () => {
    let now = Date.now() - 30 * 60_000;
    const warms: number[] = [];
    const d = deps({ warmGuardian: async () => warms.push(now) });
    await send(turn("turn_warm000001", "hello", HANDLE, 0, now), d);
    now += 60_000;
    await send(turn("turn_warm000002", "and another thing", HANDLE, 0, now), d);
    expect(warms).toHaveLength(1);
    // A retry of a turn already recorded never warms again.
    await send(turn("turn_warm000002", "and another thing", HANDLE, 0, now), d);
    expect(warms).toHaveLength(1);
    now += 20 * 60_000;
    await send(turn("turn_warm000003", "back again", HANDLE, 0, now), d);
    expect(warms).toHaveLength(2);
  });

  it("reads the gap from Engine, so a second instance does not warm mid-conversation", async () => {
    const at = Date.now() - 60_000;
    const warms: number[] = [];
    await send(turn("turn_warm000005", "hello", HANDLE, 0, at), deps({ warmGuardian: async () => warms.push(1) }));
    await send(turn("turn_warm000006", "more", HANDLE, 0, at + 30_000), deps({ warmGuardian: async () => warms.push(2) }));
    expect(warms).toEqual([1]);
  });

  it("a failed warm-up never affects the turn", async () => {
    const res = await send(turn("turn_warm000004", "hello"), deps({ warmGuardian: async () => Promise.reject(new Error("down")) }));
    expect(res.status).toBe(200);
  });
});

describe("turn timing log", () => {
  it("logs where the turn's time went as numbers, with no message text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await send(turn("turn_time_000001", "Hi there, I just heard about Mano"));
    expect(res.status).toBe(200);
    const line = log.mock.calls.map(([l]) => String(l)).find((l) => l.includes('"type":"mano_turn"'))!;
    log.mockRestore();
    const entry = JSON.parse(line) as { steps: Record<string, number>; engine: Record<string, [number, number]> };
    expect(Object.keys(entry.steps)).toEqual(expect.arrayContaining(["ledger", "close", "profile", "agent"]));
    expect(Object.keys(entry.engine)).toEqual(expect.arrayContaining(["POST /turns", "POST /approvals/supersede", "GET /profile", "GET /approvals"]));
    expect(entry.engine["POST /turns"][0]).toBe(1);
    expect(line).not.toMatch(/heard about|turn_time/);
  });
});

describe("a person who writes in another language", () => {
  const approved = () => engine.approvals().map((a) => JSON.parse(a.requestJson).payload);

  // The fill double's profile, with a language already on it.
  function languageOnFile(value: string, source: string) {
    const profile = engine.profile as { person: Record<string, unknown> };
    profile.person.language = { value, source, updatedAt: "2026-11-01T00:00:00Z" };
  }

  // A plain turn against the real profile store, and what it left there.
  async function afterPlainTurn(turnId: string, text: string) {
    engine.profile = null;
    const kept: Promise<unknown>[] = [];
    await send(turn(turnId, text), deps({ background: (work) => kept.push(work) }));
    await Promise.all(kept);
    return engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0).getProfileView();
  }

  it("gets the question in Spanish with the values exact, and a si files that version once", async () => {
    const ask = await send(turn("turn_es_000000001", "Quiero mi renewal por favor"));
    expect(ask.body.status).toBe("waiting_approval");
    expect(ask.body.approval).toMatch(/^Listo para enviar: /);
    expect(ask.body.approval).toContain("WA-SNAP-0042117");
    expect(ask.body.approval).toContain("253-555-0100");
    expect(approved()[0]).toMatchObject({ caseNumber: "WA-SNAP-0042117", phone: "253-555-0100" });

    const yes = await send(turn("turn_es_00000000y", "s\u00ed"));
    expect(yes.body.text).toMatch(/^Listo\. Enviado: /);
    expect(engine.approvals()[0]!.status).not.toBe("pending");
  });

  it("gets the question in Vietnamese and Tagalog too", async () => {
    const vi_ = await send(turn("turn_vi_000000001", "T\u00f4i c\u1ea7n renewal"));
    expect(vi_.body.approval).toMatch(/^S\u1eb5n s\u00e0ng g\u1eedi: /);
    expect((await send(turn("turn_vi_00000000y", "c\u00f3"))).body.text).toMatch(/^Xong\. /);

    const tl = await send(turn("turn_tl_000000001", "Kailangan ko ng renewal po", OTHER));
    expect(tl.body.approval).toMatch(/^Handa nang ipadala: /);
    expect((await send(turn("turn_tl_00000000y", "opo", OTHER))).body.text).toMatch(/^Tapos na\. /);
  });

  it("keeps the language for a later short answer, from the profile", async () => {
    languageOnFile("Spanish", "agent");
    const ask = await send(turn("turn_es_000000003", "renewal 3"));
    expect(ask.body.approval).toMatch(/^Listo para enviar: /);
  });

  it("saves the language it read below anything the person says", async () => {
    const view = await afterPlainTurn("turn_es_000000002", "Hola, necesito ayuda con mis beneficios");
    expect(view.profile.person.language).toMatchObject({ value: "Spanish", source: "agent" });
  });

  it("saves nothing for English", async () => {
    const view = await afterPlainTurn("turn_en_000000002", "I need help with my food benefits");
    expect(view.profile.person.language).toBeUndefined();
  });

  it("never touches a language the person stated, and still follows the words of this turn", async () => {
    engine.profile = null;
    const person = engineClient()!.forHandle(HANDLE, grants.get(HANDLE)!, 0);
    await person.patchProfile({ idempotencyKey: "said-english", source: "person", fields: { "person.language": "English" } });
    const kept: Promise<unknown>[] = [];
    await send(turn("turn_es_000000004", "Hola, necesito ayuda con mis beneficios"), deps({ background: (work) => kept.push(work) }));
    await Promise.all(kept);
    const view = await person.getProfileView();
    expect(view.profile.person.language).toMatchObject({ value: "English", source: "person" });
    expect(view.suggestions).toEqual([]);

    installFillDouble(engine);
    languageOnFile("English", "person");
    const ask = await send(turn("turn_es_000000014", "Hola, necesito mi renewal"));
    expect(ask.body.approval).toMatch(/^Listo para enviar: /);
  });

  it("sends co, a question or a yes with a change to the model and files nothing", async () => {
    await send(turn("turn_es_000000005", "Quiero mi renewal por favor"));
    for (const [i, text] of ["co", "s\u00ed?", "si no", "s\u00ed pero cambia mi tel\u00e9fono"].entries()) {
      const before = agentCalls.length;
      await send(turn(`turn_es_00000010${i}`, text));
      expect(agentCalls.length).toBe(before + 1);
      expect(engine.approvals().filter((a) => a.status === "pending")).toHaveLength(1);
    }
  });

  it("a si to a question that has since changed files nothing", async () => {
    const { newer } = await replacedQuestion("turn_es_000000006", "turn_es_000000007");
    const answer = await send(turn("turn_es_000000008", "s\u00ed"));
    expect(answer.body.text).toMatch(/nada/i);
    expect(engine.approvals().find((a) => a.id === newer.id)!.status).toBe("pending");
  });

  it("a report only counts when it is the frozen question, in one of Mano's languages", async () => {
    const ask = await send(turn("turn_es_000000009", "Quiero mi renewal por favor"), deps(), { present: false });
    const report = (textHash: string) =>
      handlePresented(
        signedAt("/channels/mano/presented", { handleHash: HANDLE, approvalId: ask.body.approvalId, textHash, generation: 0, grant: grants.get(HANDLE) }),
        { secret: SECRET, engine: engineClient() },
      );
    expect((await report(presentationHash(`${ask.body.approval} cambiado`))).status).toBe(409);
    expect((await report(presentationHash(ask.body.approval!))).status).toBe(200);
  });

  it("a NO in Spanish or Tagalog declines in that language", async () => {
    await send(turn("turn_tl_000000002", "Kailangan ko ng renewal po"));
    const no = await send(turn("turn_tl_00000000n", "hindi"));
    expect(no.body.text).toMatch(/^Sige, hindi ko ipinadala\./);
  });
});

describe("the model on the turn response", () => {
  it("goes back to the signed caller when the deployment names it", async () => {
    const res = await handleTurn(turn("turn_mod_0000001", "hello"), deps({ modelId: "muse-spark-1.3" }));
    expect(((await res.json()) as { model?: string }).model).toBe("muse-spark-1.3");
  });

  it("is absent when it does not", async () => {
    const res = await handleTurn(turn("turn_mod_0000002", "hello"), deps());
    expect(await res.json()).not.toHaveProperty("model");
  });
});
