import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import { healthOk } from "../src/index.js";
import {
  ActionGateway,
  MemoryApprovalStore,
  TimeoutError,
} from "../src/gateway/index.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";

// Round 3 should-fix items: health tracks executor readiness,
// reconciled shares are labeled real, and the body cap counts bytes.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

describe("r3 should-fix: health, labels and byte caps", () => {
  it("reports not-ok when the executor cannot be constructed", () => {
    const full = {
      PERSON_AGENT: {},
      ORG_AGENT: {},
      FILES: {},
      META_MODEL_API_KEY: "k",
      ENCRYPTION_KEK_B64: "k",
      SESSION_SECRET: "s",
      MANO_ENGINE_AGENT_TOKEN: "t",
      MANO_HANDLE_GRANT_SECRET: "g",
      MANO_ENGINE_CHANNELS_TOKEN: "c",
      MANO_CHANNELS_URL: "https://channels.test",
      MANO_ENGINE_SEND_SECRET: "a",
    };
    expect(healthOk(full as never)).toBe(false);
    expect(healthOk({ ...full, MANO_ENV: "development" } as never)).toBe(true);
    expect(healthOk({ ...full, EXECUTOR_MODE: "nope" } as never)).toBe(false);
  });

  it("labels a reconciled share as real", async () => {
    const recorded = new Map<string, { externalId: string }>();
    let checks = 0;
    const exec: Executor = {
      simulated: true,
      async execute(req) {
        recorded.set(req.idempotencyKey, { externalId: "org-1" });
        throw new TimeoutError();
      },
      async check(key) {
        checks += 1;
        if (checks === 1) return { found: false as const };
        return { found: true as const, externalId: recorded.get(key)!.externalId };
      },
    };
    const gw = new ActionGateway(new MemoryApprovalStore(), exec);
    const req: ActionRequest = {
      type: "share",
      recipient: "org:county",
      purpose: "renewal",
      payload: { consent: "grant", caseId: "case-1" },
      idempotencyKey: "r3sf-share",
      actor: "foreground",
      personId: "maria",
      sources: [],
      origin: "person",
    };
    const pending = await gw.requestAction(req);
    await gw.approveAndExecute(pending.approval!.id, "maria");
    const retry = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(retry.status).toBe("reconciled");
    expect(retry.receipt?.simulated).toBe(false);
  });

  it("caps request bodies by bytes while streaming", async () => {
    const token = await mintSessionToken({ kind: "person", sub: "r3sf-maria" }, TEST_SESSION_SECRET);
    // 600k BMP chars: 600k UTF-16 units but 1.2 MB of UTF-8, sent
    // chunked with no content-length so only the byte count can catch it.
    const payload = JSON.stringify({ type: "send", padding: "é".repeat(600_000) });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const req = new Request("https://mano.test/api/persons/r3sf-maria/action", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await SELF.fetch(req);
    expect(res.status).toBe(413);
  });
});
