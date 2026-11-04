import { guardReply } from "@mano/persona";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor, type Profile } from "../agent/lib/engine.js";
import { presentationHash } from "../agent/lib/pending.js";
import { handlePresented, handleTurn, type AgentTurnInput, type TurnDeps } from "../agent/lib/turn.js";
import { heldOf, initialSettleState, reduceSettleEvent } from "../agent/lib/settle.js";
import shareCase from "../agent/tools/share_case.js";
import stopSharing from "../agent/tools/stop_sharing.js";
import { DefiniteFailureError, TimeoutError, type ActionRequest, type CheckOutcome, type Executor } from "../../engine/src/gateway/index.js";
import { recordDocumentRequest } from "../../engine/src/case-sharing.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

// LAP-863 as Maria texts it, through the real turn route and the real
// tools, with the model played by this file: no live model call runs.

const SECRET = "sharing-test-secret";
const HANDLE = "c".repeat(64);
const PERSON = personIdFor(HANDLE);
const OFFICE = "the Sandbox County Human Services test office";
const NOW = Date.now();
// A PNG's signature: Engine reads a photo from its bytes.
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OTHER_PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "America/Los_Angeles" }).format(new Date());

const PROFILE: Profile = {
  person: { fullName: { value: "Maria Testcase", source: "person" } as never, address: {} },
  household: [],
  income: [],
  programs: [{ id: "p1", program: { value: "SNAP", source: "person" } as never, caseNumber: { value: "WA-SNAP-0042117", source: "person" } as never }],
};

let engine: EngineDouble;
let grant: string;
let modelRuns: number;
let generation: number;

function signed(path: string, body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request(`http://agent.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

// Plays the model: asks to share or stop, or it answers plainly.
async function model(input: AgentTurnInput) {
  modelRuns += 1;
  const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs });
  const tool = /stop sharing/i.test(input.message) ? stopSharing : /see my renewal/i.test(input.message) ? shareCase : null;
  if (!tool) return { status: "replied" as const, text: "Okay.", reason: "stop", held: [] };
  const output = await tool.execute({}, ctx);
  const state = initialSettleState(input.turnId);
  reduceSettleEvent(state, { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId: "c", toolName: tool === stopSharing ? "stop_sharing" : "share_case", output } } });
  return { status: "replied" as const, text: "It is ready for your yes.", reason: "stop", held: heldOf(state) };
}

function deps(): TurnDeps {
  return {
    secret: SECRET,
    engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch }),
    runAgent: model as TurnDeps["runAgent"],
    // A photo the sharing path does not take would need a reading.
    mailModel: { generate: async () => { throw new Error("no reading in this test"); } } as never,
  };
}

let turnNumber = 0;

type Body = { status: string; text: string; approval?: string; approvalId?: string };

// One text from Maria, with Channels' report of any question it sent.
async function say(text: string | null, photoId?: string | string[], attachmentCount?: number): Promise<Body> {
  turnNumber += 1;
  const photos = photoId === undefined ? [] : [photoId].flat();
  const turnBody = {
    turnId: `turn_sharing${String(turnNumber).padStart(4, "0")}`,
    generation,
    handleHash: HANDLE,
    grant,
    receivedAt: Date.now(),
    texts: text ? [text] : [],
    attachmentCount: attachmentCount ?? photos.length,
    ...(photos.length > 0 ? { documents: photos.map((id) => ({ id, mimeType: "image/png" })) } : {}),
  };
  const res = await handleTurn(signed("/channels/mano/turn", turnBody), deps());
  const body = (await res.json()) as Body;
  if (body.status === "waiting_approval") {
    const presented = await handlePresented(
      signed("/channels/mano/presented", { handleHash: HANDLE, approvalId: body.approvalId, textHash: presentationHash(body.approval!), generation, grant }),
      { secret: SECRET, engine: deps().engine },
    );
    expect(presented.status).toBe(200);
  }
  await new Promise((r) => setTimeout(r, 3));
  return body;
}

const request = (id = "req-pay-stub-0001", caseId = currentCase()) =>
  recordDocumentRequest(engine.person(PERSON).sql, {
    recipient: "org:sandbox-county",
    id,
    caseId,
    documentKind: "pay-stub",
    requestedAt: new Date(NOW).toISOString(),
  });

function shares() {
  return engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, generation).listShares();
}

function currentCase(): string {
  const row = engine.person(PERSON).sql.exec("SELECT case_id FROM consents").toArray()[0] as { case_id: string };
  return row.case_id;
}

beforeEach(async () => {
  engine = new EngineDouble();
  engine.profile = PROFILE;
  modelRuns = 0;
  generation = 0;
  grant = await grantFor(HANDLE);
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("LAP-863: Maria shares her renewal with her caseworker", () => {
  it("asks a question that names the office and everything that goes, then shares on her yes", async () => {
    const asked = await say("I want my caseworker to see my renewal");
    expect(asked.status).toBe("waiting_approval");
    expect(asked.approval).toBe(
      `Ready to share your food benefits renewal with ${OFFICE}: Name: Maria Testcase; Program: SNAP; Case number: WA-SNAP-0042117. They can also ask you for documents, and nothing else goes to them without your yes. Reply YES to share exactly this, or NO to stop.`,
    );
    // The text line carries it word for word.
    expect(guardReply(asked.approval!).text).toBe(asked.approval);
    expect(asked.text).toContain(asked.approval!);
    expect((await shares()).active).toEqual([]);

    const done = await say("YES");
    expect(done.text).toBe(`Done. The Sandbox County Human Services test office can now see what you shared for your food benefits renewal. Tell me any time if you want to stop sharing.`);
    expect((await shares()).active).toMatchObject([{ recipient: "org:sandbox-county", purpose: "your food benefits renewal" }]);
  });

  it("shares nothing on her no", async () => {
    await say("I want my caseworker to see my renewal");
    expect((await say("NO")).text).toBe("Okay, I did not send it. Nothing left Mano.");
    expect((await shares()).active).toEqual([]);
  });

  it("asks for what is missing instead of guessing a name", async () => {
    engine.profile = { ...PROFILE, person: { address: {} } };
    const ctx = toolCtx({ handleHash: HANDLE, turnId: "turn_sharingname", grant, generation: 0, turnAtMs: NOW });
    await engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0).putTurn("turn_sharingname", new Date(NOW).toISOString());
    expect(await shareCase.execute({}, ctx)).toMatchObject({ status: "needs_answer", sent: false });
    expect(engine.approvals()).toEqual([]);
  });

  it("a photo answers the waiting request only after her yes, without the model", async () => {
    await say("I want my caseworker to see my renewal");
    await say("YES");
    request();
    engine.putDocument(PERSON, "photo-stub-1", PHOTO);
    const runs = modelRuns;

    const asked = await say(null, "photo-stub-1");
    expect(asked.approval).toBe(`Ready to send the photo you sent on ${DAY} to ${OFFICE}, as your pay stub for your food benefits renewal. Reply YES to send exactly this, or NO to stop.`);
    expect(guardReply(asked.approval!).text).toBe(asked.approval);
    const { documentId, payload } = JSON.parse(engine.approvals().at(-1)!.requestJson) as { documentId: string; payload: { requestId: string } };
    expect(documentId).toBe("photo-stub-1");
    expect(payload.requestId).toBe("req-pay-stub-0001");
    expect((await shares()).active[0]!.openRequests).toHaveLength(1);

    expect((await say("YES")).text).toBe(`Done. I sent your pay stub to ${OFFICE}.`);
    expect((await shares()).active[0]!.openRequests).toEqual([]);
    expect(modelRuns).toBe(runs);
  });

  it("two photos in one message are never guessed between: she picks by sending one", async () => {
    await say("I want my caseworker to see my renewal");
    await say("YES");
    request();
    engine.putDocument(PERSON, "photo-stub-2", PHOTO);
    engine.putDocument(PERSON, "photo-medical-2", OTHER_PHOTO);
    const before = engine.approvals().length;

    const asked = await say(null, ["photo-medical-2", "photo-stub-2"]);
    expect(asked.status).not.toBe("waiting_approval");
    expect(asked.text).toBe(
      `You sent 2 photos, and ${OFFICE} asked for your pay stub. Nothing was sent. Send just the one photo you want them to have, by itself, and I will check with you first.`,
    );
    expect(engine.approvals()).toHaveLength(before);
    expect((await say("YES")).status).not.toBe("waiting_approval");
    expect((await shares()).active[0]!.openRequests).toHaveLength(1);

    const one = await say(null, "photo-stub-2");
    expect(one.status).toBe("waiting_approval");
    expect(JSON.parse(engine.approvals().at(-1)!.requestJson).documentId).toBe("photo-stub-2");
  });

  it("a message with more photos than Channels stored is not guessed either", async () => {
    await say("I want my caseworker to see my renewal");
    await say("YES");
    request();
    engine.putDocument(PERSON, "photo-stub-3", PHOTO);
    const asked = await say(null, "photo-stub-3", 2);
    expect(asked.status).not.toBe("waiting_approval");
    expect(asked.text).toContain("Nothing was sent");
  });

  it("stopping while the share question waits closes it, so a later yes shares nothing", async () => {
    const asked = await say("I want my caseworker to see my renewal");
    expect(asked.status).toBe("waiting_approval");
    const approvalId = asked.approvalId!;

    const stopped = await say("please stop sharing");
    expect(stopped.status).not.toBe("waiting_approval");
    expect(engine.approvals().find((a) => a.id === approvalId)!.status).toBe("rejected");
    expect((await engine.fetch(`${ENGINE_URL}/api/persons/${PERSON}/pending-approval?generation=0`, { headers: { authorization: `Bearer ${ENGINE_AGENT_TOKEN}`, "x-mano-handle-grant": grant } }).then((r) => r.json()) as { pointer: unknown }).pointer).toBeNull();

    await say("YES");
    expect((await shares()).active).toEqual([]);
    expect(engine.approvals().find((a) => a.id === approvalId)!.status).toBe("rejected");
  });

  it("stop_sharing says what happened to the waiting question", async () => {
    await say("I want my caseworker to see my renewal");
    const client = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0);
    await client.putTurn("turn_stopdirect1", new Date().toISOString());
    const out = (await stopSharing.execute({}, toolCtx({ handleHash: HANDLE, turnId: "turn_stopdirect1", grant, generation: 0, turnAtMs: Date.now() }))) as { status: string; note: string };
    expect(out.status).toBe("question_closed");
    expect(out.note).toContain("a YES will not share");
  });

  it("stop_sharing does not say nothing is shared while an approved grant is still being checked", async () => {
    engine.filer = new SilentOffice();
    await say("I want my caseworker to see my renewal");
    await say("YES");
    const client = engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0);
    await client.putTurn("turn_stopdirect2", new Date().toISOString());
    const out = (await stopSharing.execute({}, toolCtx({ handleHash: HANDLE, turnId: "turn_stopdirect2", grant, generation: 0, turnAtMs: Date.now() }))) as { status: string };
    expect(out.status).toBe("earlier_share_unresolved");
  });

  it("after a delete, her next reply says what the office keeps, once", async () => {
    await say("I want my caseworker to see my renewal");
    await say("YES");
    request();
    const res = await engine.fetch(`${ENGINE_URL}/api/persons/${PERSON}/conversation`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ENGINE_AGENT_TOKEN}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    });
    expect(res.status).toBe(200);
    generation = 1;

    const first = await say("hello again");
    expect(first.text).toContain("can no longer open the documents you sent");
    expect(first.text).toContain("still has the details you approved for your food benefits renewal");
    expect(first.text).toContain("cannot recall");
    expect(first.text).toContain("Okay.");
    expect(guardReply(first.text).text).toBe(first.text);
    expect((await say("hello once more")).text).toBe("Okay.");
    expect((await shares()).active).toHaveLength(1);
  });

  it("a photo with no request waiting goes to the reading as usual", async () => {
    engine.putDocument(PERSON, "photo-letter-1", new Uint8Array([1, 2, 3]));
    const body = await say(null, "photo-letter-1");
    expect(body.status).not.toBe("waiting_approval");
    expect(engine.approvals()).toEqual([]);
  });

  it("stopping says plainly it cannot recall what was sent, and closes what was waiting", async () => {
    await say("I want my caseworker to see my renewal");
    await say("YES");
    request();

    const asked = await say("please stop sharing");
    expect(asked.approval).toBe(
      `Ready to stop sharing your food benefits renewal with ${OFFICE}. They lose access right away and cannot ask you for more. Stopping cannot recall what they already received. Reply YES to stop sharing, or NO to keep sharing.`,
    );
    expect(guardReply(asked.approval!).text).toBe(asked.approval);
    expect((await shares()).active).toHaveLength(1);

    expect((await say("YES")).text).toBe(
      "Done. The Sandbox County Human Services test office can no longer see your food benefits renewal or ask you for more. Stopping cannot recall what they already received.",
    );
    expect(await shares()).toMatchObject({ active: [], revoked: [{ recipient: "org:sandbox-county" }] });

    // A later photo is not an answer to anything: nothing is offered.
    engine.putDocument(PERSON, "photo-late-1", new Uint8Array([1, 2, 3]));
    expect((await say(null, "photo-late-1")).status).not.toBe("waiting_approval");
  });

  it("sharing again after stopping opens a new case", async () => {
    await say("I want my caseworker to see my renewal");
    await say("YES");
    const first = currentCase();
    await say("please stop sharing");
    await say("YES");

    await say("I want my caseworker to see my renewal");
    await say("YES");
    const second = currentCase();
    expect(second).not.toBe(first);
    expect((await shares()).revoked).toEqual([{ recipient: "org:sandbox-county", caseId: first }]);
  });

  it("does not ask again when the office can already see it, or to stop what is not shared", async () => {
    expect((await say("please stop sharing")).status).not.toBe("waiting_approval");
    await say("I want my caseworker to see my renewal");
    await say("YES");
    const count = engine.approvals().length;
    expect((await say("I want my caseworker to see my renewal")).status).not.toBe("waiting_approval");
    expect(engine.approvals()).toHaveLength(count);
  });

  it("says nothing was sent when the office refuses for good", async () => {
    engine.filer = new RefusingOffice();
    const asked = await say("I want my caseworker to see my renewal");
    expect(asked.status).toBe("waiting_approval");
    expect((await say("YES")).text).toBe("That did not go through, so nothing was sent.");
    expect((await shares()).active).toEqual([]);
  });
});

// Takes the delivery and never answers it: the attempt stays unknown.
class SilentOffice implements Executor {
  readonly simulated = true;
  async execute(_req: ActionRequest): Promise<{ externalId: string }> {
    throw new TimeoutError();
  }
  async check(): Promise<CheckOutcome> {
    throw new Error("office unreachable");
  }
}

class RefusingOffice implements Executor {
  readonly simulated = true;
  async execute(_req: ActionRequest): Promise<{ externalId: string }> {
    throw new DefiniteFailureError("This case is no longer shared with that organization.");
  }
  async check(): Promise<CheckOutcome> {
    return { found: false };
  }
}
