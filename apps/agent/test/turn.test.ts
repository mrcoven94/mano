import { guardReply } from "@mano/persona";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { presentationHash, renderQuestion } from "../agent/lib/pending.js";
import { handlePresented, handleTurn, type AgentTurnInput, type TurnDeps } from "../agent/lib/turn.js";
import remind from "../agent/tools/remind.js";
import startFormDraft from "../agent/tools/start_form_draft.js";
import requestsInstruction from "../agent/instructions/requests.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_CHANNELS_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const PRESENTATION_VECTOR = "33f67fe9f135d7efc24d4fbe91c1ed3c8bc540adde738809768ff2c8cbdb1245";
const SECRET = "turn-test-secret";
const HANDLE = "e".repeat(64);
const OTHER = "f".repeat(64);
const fields = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "555-0100",
  householdSize: 3,
  monthlyIncome: 1800,
};

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
async function fakeAgent(input: AgentTurnInput) {
  agentCalls.push(input);
  if (/renewal/i.test(input.message)) {
    const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs });
    const name = /Claude Testcase/.test(input.message) ? "Claude Testcase" : fields.fullName;
    const householdSize = /household of 4/.test(input.message) ? 4 : fields.householdSize;
    // The voice guard rewrites dashes, so this address cannot be shown word for word.
    const address = /with a dash/.test(input.message) ? "12 Sample Street \u2014 Unit 4, Testville" : fields.address;
    await startFormDraft.execute({ ...fields, fullName: name, address, householdSize }, ctx);
    return { status: "replied" as const, text: "Your renewal is ready for your yes.", reason: "stop" };
  }
  return { status: "replied" as const, text: `Answer ${agentCalls.length}`, reason: "stop" };
}

function engineClient() {
  return engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch });
}

function deps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return { secret: SECRET, engine: engineClient(), runAgent: fakeAgent, lastTurnAt: new Map(), ...overrides };
}

// What the request-status instruction tells the model at the next turn.
async function told(generation = 0): Promise<string> {
  const resolve = (requestsInstruction as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["turn.started"];
  const out = (await resolve({}, toolCtx({ handleHash: HANDLE, turnId: "turn_told000001", grant: grants.get(HANDLE), generation }))) as { content?: string } | null;
  return out?.content ?? "";
}

type Body = { status: string; text: string; approval?: string; approvalId?: string };

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

beforeEach(async () => {
  engine = new EngineDouble();
  agentCalls = [];
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
  grants.set(HANDLE, await grantFor(HANDLE));
  grants.set(OTHER, await grantFor(OTHER));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("approval by text", () => {
  it("question, YES: the exact frozen approval is approved and the action runs once", async () => {
    const ask = await send(turn("turn_ask_000001", "Please file my renewal"));
    expect(ask.status).toBe(200);
    expect(ask.body.text).toContain("Reply YES");
    expect(ask.body.text).toContain("Name: Rosa Testcase; Date of birth: 1990-02-03; Address: 12 Sample Street, Testville;");
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
    expect(ask.body.approval).toContain("Name: Rosa Testcase");
    expect(guardReply(ask.body.text).text).toContain(ask.body.approval);
  });

  it("a person named Claude Testcase sees their own name in the question", async () => {
    const ask = await send(turn("turn_exact00004", "Please file my renewal for Claude Testcase"));
    expect(ask.body.approval).toContain("Name: Claude Testcase");
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
    const late = engine.approvals().find((x) => JSON.parse(x.requestJson).payload.householdSize === 3)!;
    const retried = await present(late);
    expect(retried.body.ok).toBe(false);
    const yes = await send(turn("turn_slowY00001", "YES"));
    expect(yes.body.text).toMatch(/^Done/);
    expect(engine.executor.calls).toHaveLength(1);
    expect(sizes()).toEqual(["3:rejected", "4:approved"]);
  });

  it("an older draft's report after a newer question was shown is acknowledged, ignored and closes that draft", async () => {
    const { d, release } = slowA();
    const preparingA = send(turn("turn_slowA00001", "Please file my renewal"), d, { present: false });
    await new Promise((r) => setTimeout(r, 3));
    await send(turn("turn_slowB00001", "Please file my renewal, household of 4"), d);
    // Engine refuses every close while A finishes, so both drafts still wait.
    const realFetch = engine.fetch;
    const refusing: typeof fetch = async (input, init) =>
      /\/reject$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : realFetch(input, init);
    vi.stubGlobal("fetch", refusing);
    release();
    await preparingA;
    vi.stubGlobal("fetch", engine.fetch);
    expect(sizes()).toEqual(["3:pending", "4:pending"]);
    const late = engine.approvals().find((x) => JSON.parse(x.requestJson).payload.householdSize === 3)!;
    const retried = await present(late);
    expect(retried).toEqual({ status: 200, body: { ok: true, superseded: true } });
    expect(sizes()).toEqual(["3:rejected", "4:pending"]);
    const yes = await send(turn("turn_slowY00001", "YES"));
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
    let now = Date.now();
    const warms: number[] = [];
    const d = deps({ now: () => now, warmGuardian: async () => warms.push(now) });
    await send(turn("turn_warm000001", "hello"), d);
    now += 60_000;
    await send(turn("turn_warm000002", "and another thing"), d);
    expect(warms).toHaveLength(1);
    now += 20 * 60_000;
    await send(turn("turn_warm000003", "back again"), d);
    expect(warms).toHaveLength(2);
  });

  it("a failed warm-up never affects the turn", async () => {
    const res = await send(turn("turn_warm000004", "hello"), deps({ warmGuardian: async () => Promise.reject(new Error("down")) }));
    expect(res.status).toBe(200);
  });
});
