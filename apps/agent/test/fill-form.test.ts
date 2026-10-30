import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeModelClient, type Computer, type ComputerAction } from "@mano/computer";

import fillForm, { setFillDepsForTests } from "../agent/tools/fill_form.js";
import { fillDepsFromEnv } from "../agent/lib/computer-fill.js";
import { engineFrom } from "../agent/lib/engine.js";
import { renderQuestion } from "../agent/lib/pending.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "f".repeat(64);
const PORTAL = "http://portal.test";
const DRAFT_TOKEN = "portal-test-draft-token";
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
const FIELDS = Object.keys(VALUES);
// The form's Continue button on this fake screen.
const CONTINUE = { type: "click", button: "left", x: 640, y: 700 } as ComputerAction;
const DRAFT_URL = /^http:\/\/portal\.test\/apply\?draft=([0-9a-f]{32,128})$/;

// The sandbox portal as the agent sees it: GET /drafts/<id> with the
// draft token answers what the form saved, trimmed, per the portal's
// contract.
class FakePortal {
  drafts = new Map<string, Record<string, string>>();
  reads: string[] = [];
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const m = /^http:\/\/portal\.test\/drafts\/([^/?]+)$/.exec(url);
    if (!m || (init?.method ?? "GET") !== "GET") return new Response("Not found", { status: 404 });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${DRAFT_TOKEN}`) return Response.json({ error: "Unauthorized." }, { status: 401 });
    const id = m[1];
    this.reads.push(id);
    const household = this.drafts.get(id);
    if (!household) return Response.json({ id, status: "not_found" }, { status: 404 });
    return Response.json({ id, household, savedAt: Date.parse(at) });
  }
}

// A desktop showing the portal's form: typed text goes into the fields in
// order, a date field stores ISO, and Continue saves the draft the page
// was opened with.
class FakeComputer implements Computer {
  visited: string[] = [];
  acted: ComputerAction[] = [];
  closed = 0;
  private typed: string[] = [];
  private draft: string | null = null;
  constructor(private portal: FakePortal) {}
  async screenshot() {
    return new Uint8Array([137, 80, 78, 71]);
  }
  async act(actions: ComputerAction[]) {
    for (const a of actions) {
      this.acted.push(a);
      if (a.type === "type") this.typed.push(a.text);
      if (a.type === "click" && a.x === 640 && a.y === 700 && this.draft) {
        const saved = Object.fromEntries(FIELDS.map((name, i) => [name, (this.typed[i] ?? "").trim()]));
        saved.dateOfBirth = saved.dateOfBirth.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2");
        this.portal.drafts.set(this.draft, saved);
      }
    }
  }
  async goto(url: string) {
    this.visited.push(url);
    this.draft = new URL(url).searchParams.get("draft");
    this.typed = [];
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
  return [
    ...Object.entries(values).flatMap(([name, v], i) => [
      { type: "click", button: "left", x: 600, y: 270 + 32 * i } as ComputerAction,
      { type: "type", text: name === "dateOfBirth" ? v.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1") : v } as ComputerAction,
    ]),
    CONTINUE,
  ];
}

const call = (actions: ComputerAction[], checks: { id: string; code: string; message: string }[] = []) => ({
  type: "computer_call",
  id: "c1",
  call_id: "call-1",
  actions,
  pending_safety_checks: checks,
  status: "completed",
});
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });

let engine: EngineDouble;
let grant: string;
let portal: FakePortal;
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
  portal = new FakePortal();
  computer = new FakeComputer(portal);
  model = new FakeModelClient([[call(typing(VALUES))], [say("ACCEPTED")]]);
  outside = [];
  setFillDepsForTests(() => ({ computer, model, modelId: "muse-spark-1.3-contributor", deadlineMs: 5000, draftToken: DRAFT_TOKEN }));
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubEnv("MANO_PORTAL_URL", PORTAL);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ENGINE_URL)) return engine.fetch(input, init);
    if (url.startsWith(`${PORTAL}/drafts/`)) return portal.fetch(url, init);
    outside.push(url);
    return new Response("Not found", { status: 404 });
  });
});

afterEach(() => {
  setFillDepsForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fill_form", () => {
  it("fills a fresh draft on the person's computer, reads it back and holds exactly what the portal saved for YES", async () => {
    engine.profile = profile();
    const out = await run("turn_fill0001", { form: "food-renewal" });
    expect(out.status).toBe("waiting_for_yes");
    expect(computer.visited).toHaveLength(1);
    const draftId = DRAFT_URL.exec(computer.visited[0])?.[1];
    expect(draftId).toBeDefined();
    expect(portal.reads).toEqual([draftId]);
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

  it("each fill opens its own fresh draft", async () => {
    engine.profile = profile();
    await run("turn_fill0015", { form: "food-renewal" });
    model = new FakeModelClient([[call(typing(VALUES))], [say("ACCEPTED")]]);
    await run("turn_fill0016", { form: "food-renewal" });
    const ids = computer.visited.map((u) => DRAFT_URL.exec(u)?.[1]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("prepares nothing when the portal saved a value that only starts with the approved one", async () => {
    engine.profile = profile();
    model = new FakeModelClient([[call(typing({ ...VALUES, monthlyIncome: "23290" }))], [say("ACCEPTED")]]);
    const out = await run("turn_fill0017", { form: "food-renewal" });
    expect(out.status).toBe("fill_failed");
    expect(engine.approvals()).toHaveLength(0);
  });

  it("prepares nothing when the portal has no draft, or refuses the draft token", async () => {
    engine.profile = profile();
    model = new FakeModelClient([[call(typing(VALUES).slice(0, -1))], [say("ACCEPTED")]]);
    expect((await run("turn_fill0018", { form: "food-renewal" })).status).toBe("fill_failed");
    setFillDepsForTests(() => ({ computer, model, modelId: "muse-spark-1.3-contributor", deadlineMs: 5000, draftToken: "wrong-token" }));
    model = new FakeModelClient([[call(typing(VALUES))], [say("ACCEPTED")]]);
    expect((await run("turn_fill0019", { form: "food-renewal" })).status).toBe("fill_failed");
    expect(engine.approvals()).toHaveLength(0);
  });

  it("a safety check stops the fill before any action: nothing is typed or prepared, and only the check codes are logged", async () => {
    engine.profile = profile();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    model = new FakeModelClient([
      [call(typing(VALUES), [{ id: "sc1", code: "computer_action_requires_confirmation", message: "Rosa Testcase 253-555-0142" }])],
    ]);
    const out = await run("turn_fill0020", { form: "food-renewal" });
    expect(out).toMatchObject({ status: "needs_go_ahead", sent: false });
    expect(computer.acted).toEqual([]);
    expect(engine.approvals()).toHaveLength(0);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((l) => l.includes("computer_action_requires_confirmation"))).toBe(true);
    expect(lines.some((l) => l.includes("Rosa") || l.includes("253-555"))).toBe(false);
  });

  it("without a profile, says it is unavailable so the renewal goes through start_form_draft, and touches no computer", async () => {
    const out = await run("turn_fill0002", { form: "food-renewal", answers: { fullName: "Rosa Testcase" } });
    expect(out).toMatchObject({ status: "unavailable", sent: false });
    expect(String(out.note)).toContain("start_form_draft");
    expect(computer.visited).toEqual([]);
    expect(engine.approvals()).toHaveLength(0);
  });

  it("asks for one missing field at a time, and again when an answer does not fit", async () => {
    const p = profile();
    delete (p.person as Record<string, unknown>).fullName;
    delete (p.person as Record<string, unknown>).dateOfBirth;
    engine.profile = p;
    const first = await run("turn_fill0003", { form: "food-renewal" });
    expect(first).toMatchObject({ status: "needs_answer", field: "fullName" });
    const second = await run("turn_fill0004", { form: "food-renewal", answers: { fullName: "Rosa Testcase" } });
    expect(second).toMatchObject({ status: "needs_answer", field: "dateOfBirth" });
    const bad = await run("turn_fill0025", { form: "food-renewal", answers: { fullName: "Rosa Testcase", dateOfBirth: "someday" } });
    expect(bad).toMatchObject({ status: "needs_answer", field: "dateOfBirth" });
    expect(computer.visited).toEqual([]);
    expect(engine.approvals()).toHaveLength(0);
  });

  it("asks for the monthly income when any income entry lacks an amount or how often it comes", async () => {
    const p = profile();
    p.income.push({ id: "i2", memberId: "m1", source: leaf("job"), amount: { value: 400, source: "person", updatedAt: at }, frequency: undefined } as never);
    engine.profile = p;
    const out = await run("turn_fill0021", { form: "food-renewal" });
    expect(out).toMatchObject({ status: "needs_answer", field: "monthlyIncome" });
    expect(computer.visited).toEqual([]);
    const answered = await run("turn_fill0022", { form: "food-renewal", answers: { monthlyIncome: "2329" } });
    expect(answered.status).toBe("waiting_for_yes");
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
    model = new FakeModelClient([[call(typing(VALUES).slice(0, -1))], [say("REJECTED: Household size must be a whole number between 1 and 30.")]]);
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

  it("a correction whose fill fails leaves the earlier question unanswerable: YES to it files nothing", async () => {
    engine.profile = profile();
    const first = await run("turn_fill0023", { form: "food-renewal" });
    expect(first.status).toBe("waiting_for_yes");
    model = new FakeModelClient([[call(typing({ ...VALUES, householdSize: "4" }).slice(0, -1))], [say("INFEASIBLE: The page stopped responding.")]]);
    const second = await run("turn_fill0024", { form: "food-renewal", answers: { householdSize: "4" } });
    expect(second.status).toBe("fill_failed");
    expect(engine.approvals().find((a) => a.id === first.approvalId)?.status).toBe("rejected");
    const yes = await client().approve(first.approvalId as string);
    expect(yes.status).not.toBe("completed");
    expect(engine.executor.calls).toHaveLength(0);
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

describe("the computer and portal a deployment fills with", () => {
  const env = {
    META_MODEL_API_KEY: "test-model-key",
    MANO_PORTAL_URL: PORTAL,
    SANDBOX_PORTAL_DRAFT_TOKEN: DRAFT_TOKEN,
    MODAL_COMPUTER_URL: "https://computer.test",
    MODAL_COMPUTER_TOKEN: "test-computer-token",
  };

  it("opens the hosted desktop for this person's Engine id", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://computer.test/sessions") bodies.push(JSON.parse(String(init?.body)));
      return new Response("unavailable", { status: 503 });
    });
    const deps = fillDepsFromEnv("person-abc", env);
    expect("unavailable" in deps).toBe(false);
    if ("unavailable" in deps) return;
    await deps.computer.screenshot().catch(() => undefined);
    expect(bodies).toEqual([expect.objectContaining({ person_id: "person-abc" })]);
  });

  it("is not available without the portal's draft token, since nothing could be read back", () => {
    expect(fillDepsFromEnv("person-abc", { ...env, SANDBOX_PORTAL_DRAFT_TOKEN: undefined })).toEqual({ unavailable: expect.any(String) });
  });
});
