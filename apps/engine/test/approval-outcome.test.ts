import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { TimeoutError, setExecutorFactoryForTests, type Executor } from "../src/gateway/index.js";
import type { PersonAgent } from "../src/agents/person-agent.js";
import { env as testEnv } from "cloudflare:test";

// GET /approvals rows carry the action's outcome, so the agent can tell
// "filed" from "still unknown": the attempt status and the receipt. A
// filing that times out reads unknown; once a recovery sweep settles it,
// the same row reads done with its receipt.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const HANDLE = "0f".repeat(32);
const PERSON = personIdForHandle(HANDLE);

async function call(method: string, path: string, body?: unknown, handle = HANDLE) {
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(handle)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      "x-mano-handle-grant": await mintHandleGrant(handle, GRANT_SECRET),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Row = { id: string; outcome: { attempt: string | null; receipt: { externalId: string; simulated: boolean } | null; withdrawn?: boolean } };

async function row(id: string, handle = HANDLE): Promise<Row | undefined> {
  const list = (await (await call("GET", "/approvals", undefined, handle)).json()) as { approvals: Row[] };
  return list.approvals.find((a) => a.id === id);
}

afterEach(() => {
  setExecutorFactoryForTests(null);
});

describe("approval outcome", () => {
  it("reads unknown after a timeout and done with its receipt after recovery settles it", async () => {
    let filed = false;
    let checks = 0;
    const portal: Executor = {
      simulated: true,
      async execute() {
        filed = true;
        throw new TimeoutError();
      },
      async check() {
        checks += 1;
        // The portal recorded the filing, but its first lookup is not
        // consistent yet; the recovery sweep's lookup finds it.
        return filed && checks > 1 ? { found: true as const, externalId: "portal-77" } : { found: false as const };
      },
    };
    setExecutorFactoryForTests(() => portal);

    const action = (await (
      await call("POST", "/action", {
        type: "submit",
        recipient: "sandbox-agency",
        purpose: "renewal",
        payload: {},
        idempotencyKey: "outcome-1",
        actor: "foreground",
        sources: [],
        origin: "person",
        generation: 0,
      })
    ).json()) as { status: string; approval: { id: string } };
    expect(action.status).toBe("needs_approval");
    expect((await row(action.approval.id))?.outcome).toEqual({ attempt: null, receipt: null, withdrawn: false });

    const approved = (await (await call("POST", `/approvals/${action.approval.id}/approve`)).json()) as { status: string };
    expect(approved.status).toBe("blocked");
    expect((await row(action.approval.id))?.outcome).toEqual({ attempt: "unknown", receipt: null, withdrawn: false });

    await new Promise((r) => setTimeout(r, 5));
    const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
    const agent = ns.get(ns.idFromName(PERSON)) as unknown as PersonAgent;
    const swept = await agent.recoverStrandedAttempts(0);
    expect(swept.recovered.map((r) => r.status)).toEqual(["reconciled"]);
    expect((await row(action.approval.id))?.outcome).toEqual({
      attempt: "done",
      receipt: { externalId: "portal-77", simulated: true },
      withdrawn: false,
    });
  });

  // LAP-747 follow-up: the person corrected the form after approving it
  // while its filing was unresolved, so the agent withdrew it. The sweep
  // still reconciles first, finds nothing, and ends it without filing.
  it("a withdrawn filing is reconciled by the recovery sweep and never executed again", async () => {
    let posts = 0;
    const portal: Executor = {
      simulated: true,
      async execute() {
        posts += 1;
        throw new TimeoutError();
      },
      async check() {
        return { found: false as const };
      },
    };
    setExecutorFactoryForTests(() => portal);
    // A person of their own, so their agent builds this test's portal.
    const handle = "1e".repeat(32);
    const action = (await (
      await call("POST", "/action", {
        type: "submit",
        recipient: "sandbox-agency",
        purpose: "renewal",
        payload: {},
        idempotencyKey: "outcome-withdrawn",
        actor: "foreground",
        sources: [],
        origin: "person",
        generation: 0,
      }, handle)
    ).json()) as { approval: { id: string } };
    await call("POST", `/approvals/${action.approval.id}/approve`, undefined, handle);
    expect((await row(action.approval.id, handle))?.outcome).toEqual({ attempt: "unknown", receipt: null, withdrawn: false });

    const withdrawn = (await (await call("POST", `/approvals/${action.approval.id}/withdraw`, undefined, handle)).json()) as { status: string; withdrawn?: boolean };
    expect(withdrawn).toMatchObject({ status: "rejected", withdrawn: true });

    await new Promise((r) => setTimeout(r, 5));
    const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
    const agent = ns.get(ns.idFromName(personIdForHandle(handle))) as unknown as PersonAgent;
    const swept = await agent.recoverStrandedAttempts(0);
    expect(swept.recovered).toEqual([{ key: "outcome-withdrawn", status: "blocked" }]);
    expect((await row(action.approval.id, handle))?.outcome).toEqual({ attempt: "failed", receipt: null, withdrawn: true });
    expect(posts).toBe(1);
  });
});
