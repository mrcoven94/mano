// fill_form end to end in real Chromium: the Playwright stand-in for the
// person's computer, a scripted model, and a local portal that keeps
// drafts the way the sandbox portal does (the browser saves drafts only;
// filing takes the filing token on POST /submissions, which only Engine
// holds). Skipped when Playwright's Chromium is not installed.
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeModelClient, PlaywrightComputer, type ComputerAction } from "@mano/computer";

import fillForm, { setFillDepsForTests } from "../agent/tools/fill_form.js";
import { engineFrom } from "../agent/lib/engine.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const { chromium } = createRequire(new URL("../../../packages/computer/package.json", import.meta.url))("playwright") as { chromium: { executablePath(): string } };
const installed = existsSync(chromium.executablePath());

const HANDLE = "c".repeat(64);
const DRAFT_TOKEN = "chromium-test-draft-token";
const at = "2026-10-30T12:00:00.000Z";
const leaf = <T>(value: T, extra: Record<string, unknown> = {}) => ({ value, source: "person", updatedAt: at, ...extra });
const FIELDS = ["fullName", "dateOfBirth", "address", "phone", "householdSize", "monthlyIncome"] as const;
const TYPED = ["Rosa Testcase", "03/12/1984", "100 Sample St, Tacoma, WA 98402", "253-555-0142", "3", "2329"];

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// Each input sits at a fixed place on the 1280x800 screen, so the scripted
// model can click it: field i at (300, 115 + 50i), Continue at (300, 435).
function formPage(draft: string, action: string): string {
  const inputs = FIELDS.map(
    (name, i) => `<input name="${name}" type="${name === "dateOfBirth" ? "date" : "text"}" style="position:absolute;left:100px;top:${100 + 50 * i}px;width:400px;height:30px">`,
  ).join("");
  return `<form method="post" action="${action}"><input type="hidden" name="draft" value="${draft}">${inputs}<button style="position:absolute;left:100px;top:420px;width:400px;height:30px">Continue</button></form>`;
}

const portal = {
  server: null as unknown as Server,
  offsite: null as unknown as Server,
  hits: [] as string[],
  offsiteHits: [] as string[],
  authorizedFromBrowser: 0,
  drafts: new Map<string, Record<string, string>>(),
  submissions: [] as unknown[],
  // "sealed" saves drafts on the portal; "leaky" posts the form elsewhere.
  mode: "sealed" as "sealed" | "leaky",
};

async function handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://portal");
  portal.hits.push(`${req.method} ${url.pathname}`);
  const html = (s: string) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(s);
  };
  if (req.method === "GET" && url.pathname === "/apply") {
    const draft = url.searchParams.get("draft") ?? "";
    return html(formPage(draft, portal.mode === "leaky" ? `${origin(portal.offsite)}/collect` : "/apply/household"));
  }
  if (req.method === "POST" && url.pathname === "/apply/household") {
    if (req.headers.authorization) portal.authorizedFromBrowser += 1;
    const form = new URLSearchParams(await body(req));
    const draft = form.get("draft") ?? "";
    portal.drafts.set(draft, Object.fromEntries(FIELDS.map((f) => [f, (form.get(f) ?? "").trim()])));
    return html(`<form method="post" action="/apply/submit"><input type="hidden" name="draft" value="${draft}"><button style="position:fixed;inset:0;width:100%;height:100%">Submit</button></form>`);
  }
  // The browser's Submit saves the draft and files nothing.
  if (req.method === "POST" && url.pathname === "/apply/submit") {
    if (req.headers.authorization) portal.authorizedFromBrowser += 1;
    await body(req);
    return html("<h1>Draft saved</h1>");
  }
  if (req.method === "POST" && url.pathname === "/submissions") {
    portal.submissions.push(await body(req));
    res.writeHead(401);
    return res.end();
  }
  const draft = /^\/drafts\/([0-9a-f]+)$/.exec(url.pathname)?.[1];
  if (req.method === "GET" && draft) {
    if (req.headers.authorization !== `Bearer ${DRAFT_TOKEN}`) {
      res.writeHead(401);
      return res.end();
    }
    const household = portal.drafts.get(draft);
    res.writeHead(household ? 200 : 404, { "content-type": "application/json" });
    return res.end(JSON.stringify(household ? { id: draft, household, savedAt: Date.parse(at) } : { id: draft, status: "not_found" }));
  }
  res.writeHead(404);
  res.end();
}

function typing(): ComputerAction[] {
  return [
    ...TYPED.flatMap((text, i) => [{ type: "click", button: "left", x: 300, y: 115 + 50 * i } as ComputerAction, { type: "type", text } as ComputerAction]),
    { type: "click", button: "left", x: 300, y: 435 } as ComputerAction,
    // A screenshot taken the moment a form post commits can stall headless
    // Chromium, so each batch that navigates ends by waiting.
    { type: "wait" } as ComputerAction,
  ];
}
const call = (id: string, actions: ComputerAction[]) => ({ type: "computer_call", id, call_id: id, actions, pending_safety_checks: [], status: "completed" });
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });

let engine: EngineDouble;
let grant: string;
let model: FakeModelClient;
let computer: PlaywrightComputer;
const realFetch = globalThis.fetch;

function client() {
  return engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0);
}

let clock = Date.parse(at);
async function run(turnId: string) {
  clock += 1000;
  await client().putTurn(turnId, new Date(clock).toISOString());
  return (await fillForm.execute({ form: "food-renewal" }, toolCtx({ handleHash: HANDLE, turnId, grant, turnAtMs: clock }))) as Record<string, unknown>;
}

describe.skipIf(!installed)("fill_form in real Chromium", () => {
  beforeAll(async () => {
    portal.server = createServer((req, res) => void handle(req, res));
    portal.offsite = createServer((req, res) => {
      portal.offsiteHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Thanks</h1>");
    });
    await listen(portal.server);
    await listen(portal.offsite);
  });

  afterAll(() => {
    portal.server.close();
    portal.offsite.close();
  });

  beforeEach(async () => {
    grant = await grantFor(HANDLE);
    engine = new EngineDouble();
    engine.documents.set("doc-stub", "%PDF-1.4 synthetic pay stub");
    engine.profile = {
      person: {
        fullName: leaf("Rosa Testcase"),
        dateOfBirth: leaf("1984-03-12"),
        phone: leaf("253-555-0142"),
        address: { line1: leaf("100 Sample St"), city: leaf("Tacoma"), state: leaf("WA"), zip: leaf("98402") },
      },
      household: [{ id: "m1" }, { id: "m2" }],
      income: [{ id: "i1", amount: { value: 1075, source: "document", documentId: "doc-stub", updatedAt: at }, frequency: leaf("biweekly") }],
      programs: [],
    };
    Object.assign(portal, { hits: [], offsiteHits: [], authorizedFromBrowser: 0, submissions: [], mode: "sealed" });
    portal.drafts.clear();
    // Opened the way computerFromEnv opens it: the first page fixes the only origin allowed.
    computer = new PlaywrightComputer();
    setFillDepsForTests(() => ({ computer, model, modelId: "muse-spark-1.3-contributor", deadlineMs: 30_000, draftToken: DRAFT_TOKEN }));
    vi.stubEnv("ENGINE_URL", ENGINE_URL);
    vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
    vi.stubEnv("MANO_PORTAL_URL", origin(portal.server));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(ENGINE_URL) ? engine.fetch(input, init) : realFetch(input, init),
    );
  });

  afterEach(async () => {
    await computer.close();
    setFillDepsForTests(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a model that clicks the browser's Submit files nothing: the fill is held for YES and no filing reaches the portal", async () => {
    model = new FakeModelClient([[call("c1", typing())], [call("c2", [{ type: "click", button: "left", x: 640, y: 400 }, { type: "wait" }])], [say("ACCEPTED")]]);
    const out = await run("turn_chrome001");
    expect(portal.hits).toEqual(expect.arrayContaining(["POST /apply/household", "POST /apply/submit"]));
    expect(portal.submissions).toEqual([]);
    expect(portal.authorizedFromBrowser).toBe(0);
    expect(engine.executor.calls).toHaveLength(0);
    expect(out.status).toBe("waiting_for_yes");
    const [approval] = engine.approvals();
    expect(approval.status).toBe("pending");
    expect(JSON.parse(approval.requestJson).payload).toEqual({
      fullName: "Rosa Testcase",
      dateOfBirth: "1984-03-12",
      address: "100 Sample St, Tacoma, WA 98402",
      phone: "253-555-0142",
      householdSize: "3",
      monthlyIncome: "2329",
    });
  }, 60_000);

  it("a form that sends the values off the portal sends nothing there, and the fill fails without preparing an approval", async () => {
    portal.mode = "leaky";
    model = new FakeModelClient([[call("c1", typing())], [say("ACCEPTED")]]);
    const out = await run("turn_chrome002");
    await new Promise((r) => setTimeout(r, 500));
    expect(portal.hits).toContain("GET /apply");
    expect(portal.offsiteHits).toEqual([]);
    expect(out.status).toBe("fill_failed");
    expect(engine.approvals()).toHaveLength(0);
  }, 60_000);
});
