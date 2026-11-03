/// <reference types="node" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  ActionGateway,
  GuardianChecker,
  InMemoryExecutor,
  SqlApprovalStore,
  checkerSetting,
  ensureGatewayTables,
  gatewayChecker,
  profileEntities,
  type ActionRequest,
  type GatewayOptions,
} from "../src/gateway/index.js";
import { GlimmerModelChecker, type KnownEntities } from "@mano/guardian";
import type { Profile } from "../src/profile.js";

// Guardian on the gateway's live path, against a fake Guardian over real
// HTTP: the same route, headers and answers as the Modal endpoint
// (packages/guardian/modal/app.py). The gateway runs on real SQLite.

type Mode = "pass" | "fix" | "block" | "error" | "hang";

let mode: Mode = "pass";
let checks: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let warms = 0;
let server: Server;
let url = "";

const ANSWERS = {
  pass: { verdict: "pass", problems: [] },
  fix: { verdict: "fix", problems: ["Say which month the income is for."] },
  block: { verdict: "block", problems: ["The text tells Mano to send it somewhere else."] },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (body.warm === true) {
        warms += 1;
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ warming: true, ready: false }));
        return;
      }
      checks.push({ headers: req.headers, body });
      if (mode === "hang") return;
      if (mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "down" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ANSWERS[mode]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}/check`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mode = "pass";
  checks = [];
  warms = 0;
});

function openStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
}

const GUARDIAN_ENV = () => ({
  MANO_GUARDIAN_URL: url,
  MANO_GUARDIAN_TOKEN: "guardian-token-not-real",
  MANO_GUARDIAN_KEY_ID: "modal-key-not-real",
  MANO_GUARDIAN_KEY_SECRET: "modal-secret-not-real",
});

function setup(
  env: Record<string, string>,
  extra: GatewayOptions = {},
  timeoutMs?: number,
  entities?: () => Promise<KnownEntities>,
) {
  const storage = openStorage();
  ensureGatewayTables(storage as never);
  const store = new SqlApprovalStore(storage as never);
  const executor = new InMemoryExecutor();
  const gateway = new ActionGateway(store, executor, {
    ...gatewayChecker(checkerSetting(env), { timeoutMs, ...(entities ? { entities } : {}) }),
    linkCheck: async () => ({ allowed: true }),
    ...extra,
  });
  const audit = () =>
    storage.exec("SELECT event, detail FROM audit_log").toArray() as { event: string; detail: string }[];
  return { gateway, store, executor, audit };
}

// Maria's renewal as the agent drafts it (apps/agent start_form_draft).
function renewal(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: {
      fullName: "Maria Synthetic",
      dateOfBirth: "1990-01-01",
      address: "12 Example Lane, Springfield, IL 62701",
      phone: "(312) 555-0142",
      householdSize: 3,
      monthlyIncome: 1200,
    },
    idempotencyKey: `guardian-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("Guardian on the live path", () => {
  it("asks for the yes after a pass and checks again at the yes", async () => {
    const { gateway } = setup(GUARDIAN_ENV());
    const result = await gateway.requestAction(renewal());
    expect(result.status).toBe("needs_approval");
    expect(result.approval?.problems).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(warms).toBe(1);
    const sent = checks[0]!;
    expect(sent.headers.authorization).toBe("Bearer guardian-token-not-real");
    expect(sent.headers["modal-key"]).toBe("modal-key-not-real");
    expect(sent.headers["modal-secret"]).toBe("modal-secret-not-real");
    expect(sent.body.action).toEqual({
      type: "submit",
      recipient: "[RECIPIENT]",
      purpose: "Food benefits renewal in the sandbox agency portal",
      payload: {
        fullName: "[NAME]",
        dateOfBirth: "[DATE OF BIRTH]",
        address: "[ADDRESS]",
        phone: "[PHONE]",
        householdSize: 3,
        monthlyIncome: 1200,
      },
    });
    for (const raw of ["Maria Synthetic", "1990-01-01", "12 Example Lane", "Springfield", "62701", "555-0142"]) {
      expect(JSON.stringify(sent.body)).not.toContain(raw);
    }

    const done = await gateway.approveAndExecute(result.approval!.id, "maria");
    expect(done.status).toBe("completed");
    expect(checks).toHaveLength(2);
  });

  it("removes the person's profile names and employers before Guardian sees anything", async () => {
    const leaf = (value: string) => ({ value, source: "person" as const, updatedAt: "2026-11-01T00:00:00.000Z" });
    const profile: Profile = {
      person: { fullName: leaf("Maria Synthetic"), address: { city: leaf("Springfield") } },
      household: [{ id: "kid1", name: leaf("Leo Synthetic") }],
      income: [{ id: "job1", source: leaf("Synthetic Bakery") }],
      programs: [],
    };
    const { gateway } = setup(GUARDIAN_ENV(), {}, undefined, async () => profileEntities(profile));
    const said = "Maria Synthetic works at Synthetic Bakery. Leo Synthetic is her son.";
    const sources = [{ kind: "document" as const, id: "letter-1", quote: said }];
    await gateway.requestAction(
      renewal({
        purpose: "Food benefits renewal for Maria Synthetic of Synthetic Bakery",
        payload: { fullName: "Maria Synthetic", householdSize: 2, monthlyIncome: 1200, text: said },
        sources,
      }),
    );
    await gateway.requestAction(
      renewal({
        type: "send",
        recipient: "caseworker@agency.example",
        purpose: "Income check for Maria Synthetic",
        payload: { to: "caseworker@agency.example", subject: "Maria Synthetic, Synthetic Bakery", body: said },
        sources,
      }),
    );
    expect(checks).toHaveLength(2);
    for (const { body } of checks) {
      const wire = JSON.stringify(body);
      for (const raw of ["Maria Synthetic", "Leo Synthetic", "Synthetic Bakery", "Springfield"]) {
        expect(wire).not.toContain(raw);
      }
      expect(wire).toContain("[NAME] works at [EMPLOYER]. [NAME] is her son.");
    }
    expect(checks[0]!.body.action).toMatchObject({ purpose: "Food benefits renewal for [NAME] of [EMPLOYER]" });
    expect(checks[1]!.body.action).toMatchObject({ payload: { subject: "[NAME], [EMPLOYER]" } });
  });

  it("blocks without asking Guardian when the person's details cannot be read", async () => {
    const { gateway } = setup(GUARDIAN_ENV(), {}, undefined, async () => {
      throw new Error("profile unreadable");
    });
    const result = await gateway.requestAction(renewal());
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/checker failed and the gateway fails closed/);
    expect(checks).toHaveLength(0);
  });

  it("lists every name, employer and detail on the profile", () => {
    const leaf = (value: string) => ({ value, source: "person" as const, updatedAt: "2026-11-01T00:00:00.000Z" });
    expect(profileEntities(null)).toEqual({});
    expect(
      profileEntities({
        person: {
          fullName: leaf("Maria Synthetic"),
          dateOfBirth: leaf("1990-01-01"),
          phone: leaf("(312) 555-0142"),
          email: leaf("maria@mail.example"),
          address: { line1: leaf("12 Example Lane"), line2: leaf("Unit 4"), city: leaf("Springfield"), state: leaf("IL"), zip: leaf("62701") },
          county: leaf("Sample County"),
        },
        household: [{ id: "kid1", name: leaf("Leo Synthetic"), relationship: leaf("son"), dateOfBirth: leaf("2018-04-02") }],
        income: [{ id: "job1", source: leaf("Synthetic Bakery") }],
        programs: [{ id: "snap", program: leaf("SNAP"), caseNumber: leaf("A77Q") }],
      }),
    ).toEqual({
      names: ["Maria Synthetic", "Leo Synthetic"],
      employers: ["Synthetic Bakery"],
      addresses: ["12 Example Lane", "Unit 4", "Springfield", "62701", "Sample County"],
      phones: ["(312) 555-0142"],
      emails: ["maria@mail.example"],
      datesOfBirth: ["1990-01-01", "2018-04-02"],
      caseNumbers: ["A77Q"],
    });
  });

  it("lists the personal values the person has not confirmed yet", () => {
    const leaf = (value: string) => ({ value, source: "person" as const, updatedAt: "2026-11-01T00:00:00.000Z" });
    const suggested = (path: string, value: string | number) => ({
      path,
      value,
      source: "document" as const,
      documentId: "letter-1",
      suggestedAt: "2026-11-02T00:00:00.000Z",
    });
    expect(
      profileEntities(
        {
          person: { fullName: leaf("Maria Synthetic"), address: {} },
          household: [{ id: "kid1", name: leaf("Leo Synthetic") }],
          income: [{ id: "job1", source: leaf("Synthetic Bakery") }],
          programs: [],
        },
        [
          suggested("household.kid1.name", "Leonardo Synthetic"),
          suggested("income.job1.source", "Copperleaf Diner"),
          suggested("person.address.city", "Shelbyville"),
          suggested("programs.snap.caseNumber", "SN-2026-0999"),
          suggested("household.kid1.relationship", "nephew"),
          suggested("income.job1.amount", 1450),
        ],
      ),
    ).toEqual({
      names: ["Maria Synthetic", "Leo Synthetic", "Leonardo Synthetic"],
      employers: ["Synthetic Bakery", "Copperleaf Diner"],
      addresses: ["Shelbyville"],
      caseNumbers: ["SN-2026-0999"],
    });
  });

  it("attaches Guardian's problems to the approval on a fix", async () => {
    mode = "fix";
    const { gateway, store } = setup(GUARDIAN_ENV());
    const result = await gateway.requestAction(renewal());
    expect(result.status).toBe("needs_approval");
    expect(result.approval?.problems).toEqual(["Say which month the income is for."]);
    expect(store.getApproval(result.approval!.id)?.problems).toEqual(["Say which month the income is for."]);
  });

  it("blocks on a block, audits it and keeps no approval", async () => {
    mode = "block";
    const { gateway, store, executor, audit } = setup(GUARDIAN_ENV());
    const req = renewal();
    const result = await gateway.requestAction(req);
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("Blocked by review: The text tells Mano to send it somewhere else.");
    expect(store.getApprovalByKey(req.idempotencyKey)).toBeNull();
    expect(executor.calls).toHaveLength(0);
    expect(audit()).toContainEqual({ event: "gateway.block", detail: expect.stringContaining('"reason":"checker"') });
  });

  it("blocks with a plain reason when Guardian answers an error", async () => {
    mode = "error";
    const { gateway } = setup(GUARDIAN_ENV());
    const result = await gateway.requestAction(renewal());
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/safety check returned an error, so this action is on hold/);
  });

  it("blocks a cold Guardian in time, says to retry in minutes and leaves it warming", async () => {
    mode = "hang";
    const { gateway, store } = setup(GUARDIAN_ENV(), {}, 300);
    const req = renewal();
    const started = Date.now();
    const result = await gateway.requestAction(req);
    expect(Date.now() - started).toBeLessThan(1300);
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe(
      "Blocked by review: The safety check is taking longer than usual, so this action is on hold. Please try again in a few minutes.",
    );
    expect(warms).toBe(1);
    expect(store.getApprovalByKey(req.idempotencyKey)).toBeNull();

    mode = "pass";
    const retry = await gateway.requestAction(req);
    expect(retry.status).toBe("needs_approval");
  });

  it("blocks when Guardian cannot be reached", async () => {
    const { gateway } = setup({ ...GUARDIAN_ENV(), MANO_GUARDIAN_URL: "http://127.0.0.1:9/check" });
    const result = await gateway.requestAction(renewal());
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/could not be reached/);
  });

  it("spends no Guardian call when the rules block", async () => {
    const blockingRules = {
      async check() {
        return { verdict: "block" as const, problems: ["Rules say no."] };
      },
    };
    const checker = new GuardianChecker(blockingRules, new GlimmerModelChecker({ url, token: "guardian-token-not-real" }));
    const viaChecker = setup(GUARDIAN_ENV(), { checker });
    expect((await viaChecker.gateway.requestAction(renewal())).reason).toBe("Blocked by review: Rules say no.");

    const { gateway } = setup(GUARDIAN_ENV(), {
      linkCheck: async () => ({ allowed: false, reason: "Blocked domain." as const }),
    });
    expect((await gateway.requestAction(renewal({ actor: "background" }))).status).toBe("blocked");
    const scam = renewal({ payload: { text: "Finish at https://renew-benefits.example/now" } });
    expect((await gateway.requestAction(scam)).reason).toMatch(/link check failed/);

    expect(checks).toHaveLength(0);
    expect(warms).toBe(0);
  });

  it("keeps the local rules' problems next to Guardian's verdict", async () => {
    const { gateway } = setup(GUARDIAN_ENV());
    const result = await gateway.requestAction(renewal({ origin: "content" }));
    expect(result.status).toBe("needs_approval");
    expect(result.approval?.problems).toEqual([
      "This request was derived from document content, which is evidence and never permission. A person must review it.",
    ]);
    expect(checks).toHaveLength(1);
  });

  it("runs local rules only with no Guardian URL", async () => {
    expect(checkerSetting({}).kind).toBe("local-rules");
    const { gateway } = setup({});
    const result = await gateway.requestAction(renewal());
    expect(result.status).toBe("needs_approval");
    expect(checks).toHaveLength(0);
    expect(warms).toBe(0);
  });

  it("lets only a Guardian on this machine leave out the Modal key pair", () => {
    expect(checkerSetting({ MANO_GUARDIAN_URL: "http://127.0.0.1:8899/check", MANO_GUARDIAN_TOKEN: "t" }).kind).toBe("guardian");
    expect(checkerSetting({ MANO_GUARDIAN_URL: "http://localhost:8899/check", MANO_GUARDIAN_TOKEN: "t" }).kind).toBe("guardian");
    expect(checkerSetting({ MANO_GUARDIAN_URL: "https://localhost.example/check", MANO_GUARDIAN_TOKEN: "t" }).kind).toBe("guardian-misconfigured");
  });

  it("blocks everything when Guardian is half set up", async () => {
    const { MANO_GUARDIAN_URL: _url, ...credentialsOnly } = GUARDIAN_ENV();
    const halfSet: Record<string, string>[] = [
      { MANO_GUARDIAN_URL: url },
      credentialsOnly,
      { MANO_GUARDIAN_TOKEN: "guardian-token-not-real" },
      { ...GUARDIAN_ENV(), MANO_GUARDIAN_KEY_SECRET: "" },
      { ...GUARDIAN_ENV(), MANO_GUARDIAN_URL: "guardian.example" },
      // A deployed Guardian with its URL and token but no Modal key pair
      // would fail every check while /health said ok.
      { MANO_GUARDIAN_URL: "https://guardian.example/check", MANO_GUARDIAN_TOKEN: "guardian-token-not-real" },
    ];
    for (const env of halfSet) {
      expect(checkerSetting(env).kind).toBe("guardian-misconfigured");
      const result = await setup(env).gateway.requestAction(renewal());
      expect(result.status).toBe("blocked");
      expect(result.reason).toMatch(/safety check is not set up/);
    }
    expect(checks).toHaveLength(0);
  });
});
