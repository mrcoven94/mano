/// <reference types="node" />
import { MapDocumentStore } from "../src/gateway/index.js";
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
  type ActionRequest,
  type Checker,
  type GatewayOptions,
} from "../src/gateway/index.js";
import { DefiniteFailureError } from "../src/gateway/types.js";

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

function setup(env: Record<string, string>, extra: GatewayOptions = {}, timeoutMs?: number) {
  const storage = openStorage();
  ensureGatewayTables(storage as never);
  const store = new SqlApprovalStore(storage as never);
  const executor = new InMemoryExecutor();
  const gateway = new ActionGateway(store, executor, {
    ...gatewayChecker(checkerSetting(env), { timeoutMs }),
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
    payload: { fullName: "Maria Synthetic", householdSize: 3, monthlyIncome: 1200 },
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
    expect(sent.body.action).toMatchObject({ type: "submit", recipient: "[RECIPIENT]" });
    expect(JSON.stringify(sent.body)).not.toContain("Maria Synthetic");

    const done = await gateway.approveAndExecute(result.approval!.id, "maria");
    expect(done.status).toBe("completed");
    expect(checks).toHaveLength(2);
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
    const checker = new GuardianChecker(blockingRules, { url, token: "guardian-token-not-real" });
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

  it("blocks everything when Guardian is half set up", async () => {
    const { MANO_GUARDIAN_URL: _url, ...credentialsOnly } = GUARDIAN_ENV();
    const halfSet: Record<string, string>[] = [
      { MANO_GUARDIAN_URL: url },
      credentialsOnly,
      { MANO_GUARDIAN_TOKEN: "guardian-token-not-real" },
      { ...GUARDIAN_ENV(), MANO_GUARDIAN_KEY_SECRET: "" },
      { ...GUARDIAN_ENV(), MANO_GUARDIAN_URL: "guardian.example" },
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

// Guardian scales to zero. A yes that finds it cold must not cost the
// person their approval: the approval keeps waiting, Engine says the
// refusal can be retried, and a later yes files it exactly once.
describe("a yes that finds the safety check unavailable", () => {
  async function drafted(extra: GatewayOptions = {}, timeoutMs?: number) {
    const env = setup(GUARDIAN_ENV(), extra, timeoutMs);
    const result = await env.gateway.requestAction(renewal());
    expect(result.status).toBe("needs_approval");
    return { ...env, approvalId: result.approval!.id };
  }

  it("keeps a yes that finds Guardian cold waiting, and a later yes files it once", async () => {
    const { gateway, store, executor, approvalId } = await drafted({}, 300);
    mode = "hang";
    const cold = await gateway.approveAndExecute(approvalId, "maria");
    expect(cold).toEqual({
      status: "blocked",
      retryable: true,
      reason:
        "Blocked by review: The safety check is taking longer than usual, so this action is on hold. Please try again in a few minutes.",
    });
    expect(store.getApproval(approvalId)?.status).toBe("pending");
    expect(executor.calls).toHaveLength(0);

    mode = "pass";
    const warm = await gateway.approveAndExecute(approvalId, "maria");
    expect(warm.status).toBe("completed");
    expect(executor.calls).toHaveLength(1);

    const again = await gateway.approveAndExecute(approvalId, "maria");
    expect(again.status).not.toBe("completed");
    expect(again.retryable).toBeUndefined();
    expect(executor.calls).toHaveLength(1);
  });

  it("a late unavailable check never says retryable after another yes filed it", async () => {
    let calls = 0;
    const checker = {
      async check() {
        calls += 1;
        if (calls === 2) {
          await new Promise((r) => setTimeout(r, 50));
          return { verdict: "block", problems: ["The safety check is taking longer than usual."], unavailable: true };
        }
        return { verdict: "pass", problems: [] };
      },
    } as unknown as GatewayOptions["checker"];
    const { gateway, executor, approvalId } = await drafted({ checker });
    const [late, first] = await Promise.all([
      gateway.approveAndExecute(approvalId, "maria"),
      gateway.approveAndExecute(approvalId, "maria"),
    ]);
    expect(first.status).toBe("completed");
    expect(late.status).toBe("blocked");
    expect(late.retryable).toBeUndefined();
    expect(executor.calls).toHaveLength(1);
  });

  it("a changed document is stale at the yes even when Guardian cannot answer", async () => {
    const documents = new MapDocumentStore(new Map<string, Uint8Array | string>([["letter", "%PDF-1.4 renewal v1"]]));
    const env = setup(GUARDIAN_ENV(), { documents }, 300);
    const drafted1 = await env.gateway.requestAction(renewal({ documentId: "letter" }));
    expect(drafted1.status).toBe("needs_approval");
    documents.set("letter", "%PDF-1.4 renewal v2, changed");
    mode = "hang";
    const yes = await env.gateway.approveAndExecute(drafted1.approval!.id, "maria");
    expect(yes.status).toBe("stale");
    expect(yes.retryable).toBeUndefined();
    expect(env.executor.calls).toHaveLength(0);
  });

  it("marks a Guardian error or an unreachable Guardian at the yes as retryable", async () => {
    const { gateway, store, executor, approvalId } = await drafted();
    mode = "error";
    const failed = await gateway.approveAndExecute(approvalId, "maria");
    expect(failed).toMatchObject({ status: "blocked", retryable: true });
    expect(failed.reason).toMatch(/safety check returned an error/);
    expect(store.getApproval(approvalId)?.status).toBe("pending");

    const offline = new ActionGateway(store, executor, {
      ...gatewayChecker(checkerSetting({ ...GUARDIAN_ENV(), MANO_GUARDIAN_URL: "http://127.0.0.1:9/check" })),
      linkCheck: async () => ({ allowed: true }),
    });
    const down = await offline.approveAndExecute(approvalId, "maria");
    expect(down).toMatchObject({ status: "blocked", retryable: true });
    expect(down.reason).toMatch(/could not be reached/);
    expect(store.getApproval(approvalId)?.status).toBe("pending");
    expect(executor.calls).toHaveLength(0);
  });

  it("marks the gateway's own checker timeout at the yes as retryable", async () => {
    let hang = false;
    const checker: Checker = {
      check: () => (hang ? new Promise(() => {}) : Promise.resolve({ verdict: "pass" as const, problems: [] })),
    };
    const { gateway, store, approvalId } = await drafted({ checker, checkerTimeoutMs: 50 });
    hang = true;
    const result = await gateway.approveAndExecute(approvalId, "maria");
    expect(result).toMatchObject({ status: "blocked", retryable: true });
    expect(store.getApproval(approvalId)?.status).toBe("pending");
  });

  it("never marks Guardian's own block at the yes as retryable", async () => {
    const { gateway, approvalId } = await drafted();
    mode = "block";
    const result = await gateway.approveAndExecute(approvalId, "maria");
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("Blocked by review: The text tells Mano to send it somewhere else.");
    expect(result.retryable).toBeUndefined();
  });

  it("never marks a policy, link or executor refusal at the yes as retryable", async () => {
    const policy = await drafted();
    const blockingPolicy = new ActionGateway(policy.store, policy.executor, {
      ...gatewayChecker(checkerSetting(GUARDIAN_ENV())),
      linkCheck: async () => ({ allowed: true }),
      policyOverrides: { submit: "block" },
    });
    const byPolicy = await blockingPolicy.approveAndExecute(policy.approvalId, "maria");
    expect(byPolicy.status).toBe("blocked");
    expect(byPolicy.retryable).toBeUndefined();

    let linkAllowed = true;
    const link = setup(GUARDIAN_ENV(), { linkCheck: async () => (linkAllowed ? { allowed: true } : { allowed: false, reason: "Blocked domain." as const }) });
    const linked = await link.gateway.requestAction(renewal({ payload: { text: "Finish at https://renew-benefits.example/now" } }));
    expect(linked.status).toBe("needs_approval");
    linkAllowed = false;
    const byLink = await link.gateway.approveAndExecute(linked.approval!.id, "maria");
    expect(byLink.reason).toMatch(/link check failed/);
    expect(byLink.retryable).toBeUndefined();

    const refusing = {
      simulated: true,
      async execute(): Promise<{ externalId: string }> {
        throw new DefiniteFailureError("The portal turned it down.");
      },
      async check() {
        return { found: false as const };
      },
    };
    const exec = await drafted({});
    const byExecutor = await new ActionGateway(exec.store, refusing, {
      ...gatewayChecker(checkerSetting(GUARDIAN_ENV())),
      linkCheck: async () => ({ allowed: true }),
    }).approveAndExecute(exec.approvalId, "maria");
    expect(byExecutor.status).toBe("blocked");
    expect(byExecutor.reason).toMatch(/failed before anything happened/);
    expect(byExecutor.retryable).toBeUndefined();
  });
});
