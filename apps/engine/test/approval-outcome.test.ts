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

async function call(method: string, path: string, body?: unknown) {
  return SELF.fetch(`https://engine.test/api/persons/${PERSON}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      "x-mano-handle-grant": await mintHandleGrant(HANDLE, GRANT_SECRET),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Row = { id: string; outcome: { attempt: string | null; receipt: { externalId: string; simulated: boolean } | null } };

async function row(id: string): Promise<Row | undefined> {
  const list = (await (await call("GET", "/approvals")).json()) as { approvals: Row[] };
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
    expect((await row(action.approval.id))?.outcome).toEqual({ attempt: null, receipt: null });

    const approved = (await (await call("POST", `/approvals/${action.approval.id}/approve`)).json()) as { status: string };
    expect(approved.status).toBe("blocked");
    expect((await row(action.approval.id))?.outcome).toEqual({ attempt: "unknown", receipt: null });

    await new Promise((r) => setTimeout(r, 5));
    const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
    const agent = ns.get(ns.idFromName(PERSON)) as unknown as PersonAgent;
    const swept = await agent.recoverStrandedAttempts(0);
    expect(swept.recovered.map((r) => r.status)).toEqual(["reconciled"]);
    expect((await row(action.approval.id))?.outcome).toEqual({
      attempt: "done",
      receipt: { externalId: "portal-77", simulated: true },
    });
  });
});
