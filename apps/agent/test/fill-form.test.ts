import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeModelClient, type Computer, type ComputerAction } from "@mano/computer";

import fillForm, { setFillDepsForTests } from "../agent/tools/fill_form.js";
import { engineFrom } from "../agent/lib/engine.js";
import { renderQuestion } from "../agent/lib/pending.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "f".repeat(64);
const PORTAL = "http://portal.test";
const PAY_STUB = "%PDF-1.4 synthetic pay stub";
const at = "2026-10-30T12:00:00.000Z";
const leaf = <T>(value: T, extra: Record<string, unknown> = {}) => ({ value, source: "person", updatedAt: at, ...extra });

// A synthetic person, in Profile's contract shape.
function profile() {
  return {
    person: {
      fullName: leaf("Rosa Testcase"),
      dateOfBirth: leaf("1984-03-12"),
      phone: leaf("253-555-0142"),
      address: { line1: leaf("100 Sample St"), city: leaf("Tacoma"), state: leaf("WA"), zip: leaf("98402") },
    },
    household: [
      { id: "m1", name: leaf("Ana Testcase"), relationship: leaf("child") },
      { id: "m2", name: leaf("Luis Testcase"), relationship: leaf("child") },
    ],
    income: [
      { id: "i1", memberId: "self", source: leaf("job"), amount: { value: 1075, source: "document", documentId: "doc-stub", updatedAt: at }, frequency: leaf("biweekly") },
    ],
    programs: [],
  };
}

const VALUES = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1984-03-12",
  address: "100 Sample St, Tacoma, WA 98402",
  phone: "253-555-0142",
  householdSize: "3",
  monthlyIncome: "2329",
};

// A desktop that records what it was asked to do.
class FakeComputer implements Computer {
  visited: string[] = [];
  acted: ComputerAction[] = [];
  closed = 0;
  async screenshot() {
    return new Uint8Array([137, 80, 78, 71]);
  }
  async act(actions: ComputerAction[]) {
    this.acted.push(...actions);
  }
  async goto(url: string) {
    this.visited.push(url);
  }
  async stageFile(name: string) {
    return `/uploads/${name}`;
  }
  fileUploadHint() {
    return "";
  }
  liveViewUrl() {
    return null;
  }
  async close() {
    this.closed += 1;
  }
}

function typing(values: Record<string, string>): ComputerAction[] {
  return Object.entries(values).flatMap(([name, v], i) => [
    { type: "click", button: "left", x: 600, y: 270 + 32 * i } as ComputerAction,
    { type: "type", text: name === "dateOfBirth" ? v.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1") : v } as ComputerAction,
  ]);
}

const call = (actions: ComputerAction[]) => ({ type: "computer_call", id: "c1", call_id: "call-1", actions, pending_safety_checks: [], status: "completed" });
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });

let engine: EngineDouble;
let grant: string;
let computer: FakeComputer;
let model: FakeModelClient;
let outside: string[];

function client() {
  return engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0);
}

let clock = Date.parse(at);
async function ctx(turnId: string) {
  clock += 1000;
  await client().putTurn(turnId, new Date(clock).toISOString());
  return toolCtx({ handleHash: HANDLE, turnId, grant, turnAtMs: clock });
}

async function run(turnId: string, input: { form: string; answers?: Record<string, string> }) {
  return (await fillForm.execute(input, await ctx(turnId))) as Record<string, unknown>;
}

beforeEach(async () => {
  grant = await grantFor(HANDLE);
  engine = new EngineDouble();
  engine.documents.set("doc-stub", PAY_STUB);
  computer = new FakeComputer();
  model = new FakeModelClient([[call(typing(VALUES))], [say("ACCEPTED")]]);
  outside = [];
  setFillDepsForTests(() => ({ computer, model, modelId: "muse-spark-1.3-contributor", deadlineMs: 5000 }));
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubEnv("MANO_PORTAL_URL", PORTAL);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ENGINE_URL)) return engine.fetch(input, init);
    outside.push(url);
    return new Response("Not found", { status: 404 });
  });
});

afterEach(() => {
  setFillDepsForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fill_form", () => {
  it("fills the form on the person's computer from their profile and holds the exact version for YES", async () => {
    engine.profile = profile();
    const out = await run("turn_fill0001", { form: "food-renewal" });
    expect(out.status).toBe("waiting_for_yes");
    expect(computer.visited).toEqual([`${PORTAL}/apply`]);
    expect(computer.closed).toBe(1);
    expect(outside).toEqual([]);
    expect(engine.executor.calls).toHaveLength(0);
    const [approval] = engine.approvals();
    expect(approval.status).toBe("pending");
    const frozen = JSON.parse(approval.requestJson);
    expect(frozen.payload).toEqual(VALUES);
    expect(frozen.documentId).toBe("doc-stub");
    expect(approval.documentHash).toMatch(/^[0-9a-f]{64}$/);
    const question = renderQuestion((await client().listApprovals())[0]);
    expect(question).toContain(
      "Full legal name: Rosa Testcase; Date of birth: 1984-03-12; Mailing address: 100 Sample St, Tacoma, WA 98402; Phone number: 253-555-0142; People in household: 3; Monthly income ($): 2329.",
    );
    expect(question).toContain("With your document attached.");
    expect(model.requests.every((r) => r.store === false)).toBe(true);
  });

  it("without a profile, asks for one missing field at a time and touches no computer", async () => {
    const first = await run("turn_fill0002", { form: "food-renewal" });
    expect(first).toMatchObject({ status: "needs_answer", field: "fullName", profileAvailable: false });
    const second = await run("turn_fill0003", { form: "food-renewal", answers: { fullName: "Rosa Testcase" } });
    expect(second).toMatchObject({ status: "needs_answer", field: "dateOfBirth" });
    const bad = await run("turn_fill0004", { form: "food-renewal", answers: { fullName: "Rosa Testcase", dateOfBirth: "someday" } });
    expect(bad).toMatchObject({ status: "needs_answer", field: "dateOfBirth" });
    expect(computer.visited).toEqual([]);
    expect(engine.approvals()).toHaveLength(0);
  });

  it("asks for the proof document when no profile value came from one", async () => {
    const p = profile();
    p.income[0].amount = { value: 1075, source: "person", updatedAt: at } as never;
    engine.profile = p;
    const out = await run("turn_fill0005", { form: "food-renewal" });
    expect(out).toMatchObject({ status: "needs_answer", field: "proof" });
    expect(engine.approvals()).toHaveLength(0);
  });

  it("refuses any address that is not the sandbox portal", async () => {
    engine.profile = profile();
    const out = await run("turn_fill0006", { form: "https://real-benefits.example.gov/apply" });
    expect(out.status).toBe("unknown_form");
    expect(computer.visited).toEqual([]);
    expect(engine.approvals()).toHaveLength(0);
  });

  it("prepares nothing when the form refuses the values or a value was not typed as approved", async () => {
    engine.profile = profile();
    model = new FakeModelClient([[call(typing(VALUES))], [say("REJECTED: Household size must be a whole number between 1 and 30.")]]);
    expect((await run("turn_fill0007", { form: "food-renewal" })).status).toBe("form_refused");
    model = new FakeModelClient([[call(typing({ ...VALUES, monthlyIncome: "2392" }))], [say("ACCEPTED")]]);
    expect((await run("turn_fill0008", { form: "food-renewal" })).status).toBe("fill_failed");
    expect(engine.approvals()).toHaveLength(0);
  });

  it("files on YES through the gateway with exactly the approved values and document", async () => {
    engine.profile = profile();
    const out = await run("turn_fill0009", { form: "food-renewal" });
    const result = await client().approve(out.approvalId as string);
    expect(result.status).toBe("completed");
    expect(engine.executor.calls).toHaveLength(1);
    expect(engine.executor.calls[0].payload).toEqual(VALUES);
    expect(engine.executor.calls[0].document?.bytesB64).toBe(btoa(PAY_STUB));
  });

  it("a changed field makes the earlier approval unusable, and only the new version can be filed", async () => {
    engine.profile = profile();
    const first = await run("turn_fill0010", { form: "food-renewal" });
    model = new FakeModelClient([[call(typing({ ...VALUES, householdSize: "4" }))], [say("ACCEPTED")]]);
    const second = await run("turn_fill0011", { form: "food-renewal", answers: { householdSize: "4" } });
    expect(second.status).toBe("waiting_for_yes");
    expect(engine.approvals().find((a) => a.id === first.approvalId)?.status).toBe("rejected");
    const old = await client().approve(first.approvalId as string);
    expect(old.status).not.toBe("completed");
    expect(engine.executor.calls).toHaveLength(0);
    const fresh = await client().approve(second.approvalId as string);
    expect(fresh.status).toBe("completed");
    expect(engine.executor.calls.map((c) => c.payload.householdSize)).toEqual(["4"]);
  });

  it("a document changed after the question makes the approval stale and files nothing", async () => {
    engine.profile = profile();
    const out = await run("turn_fill0012", { form: "food-renewal" });
    engine.documents.set("doc-stub", "%PDF-1.4 a different pay stub");
    const result = await client().approve(out.approvalId as string);
    expect(result.status).toBe("stale");
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("after a filing times out, reconciles before any retry and files once", async () => {
    engine.profile = profile();
    const out = await run("turn_fill0013", { form: "food-renewal" });
    engine.executor.failNextWithTimeout = true;
    const first = await client().approve(out.approvalId as string);
    expect(first.status).toBe("reconciled");
    expect(first.receipt?.externalId).toBe("sim-1");
    const again = await client().approve(out.approvalId as string);
    expect(again.status).not.toBe("needs_approval");
    expect(engine.executor.calls).toHaveLength(1);
  });

  it("refuses when Engine is not configured, and touches nothing", async () => {
    const c = await ctx("turn_fill0014");
    vi.stubEnv("ENGINE_URL", "");
    await expect(fillForm.execute({ form: "food-renewal" }, c)).rejects.toThrow(/not available/i);
    expect(computer.visited).toEqual([]);
    expect(outside).toEqual([]);
  });
});
