import { describe, expect, it } from "vitest";
import { hashHandle } from "@mano/channels";
import { handleDeletePerson, handleSendCode, routeEvent } from "../src/index.js";
import type { Env } from "../src/env.js";
import { MemoryGlobalStore } from "../src/global.js";
import { TEST_CHANNEL, TEST_HANDLE, inboundEvent, makeHarness } from "./helpers.js";

const PEPPER = "test-pepper-not-real";
const SECRET = "test-internal-secret";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    CONVERSATION: null as unknown as Env["CONVERSATION"],
    CHANNEL_STATE: null as unknown as Env["CHANNEL_STATE"],
    EVENTS: null as unknown as Env["EVENTS"],
    FILES: null as unknown as Env["FILES"],
    BLOOIO_API_KEY: "",
    BLOOIO_CHANNEL_ID: TEST_CHANNEL,
    BLOOIO_WEBHOOK_SECRET: "test-webhook-secret-not-real",
    MANO_HANDLE_PEPPER: PEPPER,
    ENCRYPTION_KEK_B64: "",
    INTERNAL_SECRET: SECRET,
    ...overrides,
  };
}

describe("sendCode", () => {
  it("sends once and replays the same key without a second send", async () => {
    const h = makeHarness();
    const first = await h.runner.sendCode(TEST_HANDLE, "Your Mano code is 123456. It expires in 10 minutes.", "code-key-1");
    expect(first.state).toBe("sent");
    expect(first.fresh).toBe(true);
    expect(h.channel.sends).toHaveLength(1);
    const second = await h.runner.sendCode(TEST_HANDLE, "Your Mano code is 123456. It expires in 10 minutes.", "code-key-1");
    expect(second.state).toBe("sent");
    expect(second.fresh).toBe(false);
    expect(h.channel.sends).toHaveLength(1);
  });

  it("marks timeouts uncertain, never failed", async () => {
    const h = makeHarness();
    const { ChannelUncertain } = await import("@mano/channels");
    let failures = 2;
    const inner = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new ChannelUncertain("Provider down in test.", 1);
      }
      return inner(input);
    };
    const sent = await h.runner.sendCode(TEST_HANDLE, "code", "code-key-2");
    expect(sent.state).toBe("uncertain");
    expect(h.store.outboundByKey("code-key-2")?.state).toBe("uncertain");
    const resolved = await h.runner.resolveUncertain();
    expect(resolved).toBe(1);
    expect(h.store.outboundByKey("code-key-2")?.state).toBe("sent");
  });

  it("reconciles a lost response through the replayed key", async () => {
    const h = makeHarness();
    h.channel.scriptFailure("code-key-3", { kind: "timeout-then-present", messageId: "msg_code_3" });
    const sent = await h.runner.sendCode(TEST_HANDLE, "code", "code-key-3");
    expect(sent.state).toBe("sent");
  });

  it("records refusals and suppresses opted-out conversations", async () => {
    const h = makeHarness();
    h.channel.scriptFailure("code-key-4", { kind: "refuse", status: 403, code: "conversation_closed" });
    const refused = await h.runner.sendCode(TEST_HANDLE, "code", "code-key-4");
    expect(refused.state).toBe("refused");
    expect(refused.code).toBe("conversation_closed");
    const meta = h.store.meta();
    meta.optedOut = true;
    h.store.saveMeta(meta);
    const suppressed = await h.runner.sendCode(TEST_HANDLE, "code", "code-key-5");
    expect(suppressed.state).toBe("refused");
    expect(suppressed.code).toBe("opted_out");
  });
});

describe("create-or-route", () => {
  it("forwards a stable person ID for the handle", async () => {
    const bodies: unknown[] = [];
    const stub = {
      fetch: async (_url: string, init: RequestInit) =>
        new Response(JSON.stringify({ result: "queued", personCreated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    };
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body ?? "{}")));
          return stub.fetch(url, init ?? {});
        },
      }),
    };
    const env = { ...baseEnv(), CONVERSATION: ns } as unknown as Env;
    const event = inboundEvent({ id: "evt_acct_1", occurredAtMs: Date.now() });
    expect(await routeEvent(event, env)).toBe("routed");
    expect(await routeEvent({ ...event, id: "evt_acct_2" }, env)).toBe("routed");
    const first = bodies[0] as { personId: string; handleHash: string };
    const second = bodies[1] as { personId: string; handleHash: string };
    expect(first.handleHash).toBe(await hashHandle(TEST_HANDLE, PEPPER));
    expect(first.personId).toMatch(/^person_/);
    expect(second.personId).toBe(first.personId);
  });
});

describe("person binds", () => {
  it("binds once, lists handles, clears on delete", async () => {
    const store = new MemoryGlobalStore();
    expect(store.notePersonBind("hash-a", "person_1")).toBe(true);
    expect(store.notePersonBind("hash-a", "person_1")).toBe(false);
    expect(store.notePersonBind("hash-b", "person_1")).toBe(true);
    expect(store.handlesForPerson("person_1").sort()).toEqual(["hash-a", "hash-b"]);
    store.clearPerson("person_1");
    expect(store.handlesForPerson("person_1")).toEqual([]);
  });
});

describe("service routes", () => {
  it("send-code needs the internal secret and forwards to the conversation", async () => {
    const calls: Array<{ name: string; body: unknown }> = [];
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          calls.push({ name: "do", body: JSON.parse(String(init?.body ?? "{}")) });
          return Response.json({ key: "code-key-9", state: "sent", code: null });
        },
      }),
    };
    const env = { ...baseEnv(), CONVERSATION: ns } as unknown as Env;
    const body = { to: TEST_HANDLE, message: "code", idempotencyKey: "code-key-9" };
    const denied = await handleSendCode(new Request("https://channels/internal/send-code", {
      method: "POST",
      body: JSON.stringify(body),
    }), env);
    expect(denied.status).toBe(403);
    const allowed = await handleSendCode(new Request("https://channels/internal/send-code", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify(body),
    }), env);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ key: "code-key-9", state: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ to: TEST_HANDLE, idempotencyKey: "code-key-9" });
  });

  it("delete-person wipes every bound conversation and unbinds", async () => {
    const deleted: string[] = [];
    const binds = new Map([["person_9", ["hash-x", "hash-y"]]]);
    const convNs = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async () => {
          deleted.push(id.name);
          return Response.json({ ok: true });
        },
      }),
    };
    const stateStub = {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.includes("/internal/person-handles")) {
          const person = new URL(url).searchParams.get("person") ?? "";
          return Response.json({ handleHashes: binds.get(person) ?? [] });
        }
        binds.delete(JSON.parse(String(init?.body ?? "{}")).personId);
        return Response.json({ ok: true });
      },
    };
    const env = {
      ...baseEnv(),
      CONVERSATION: convNs,
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stateStub },
    } as unknown as Env;
    const denied = await handleDeletePerson(new Request("https://channels/internal/delete-person", {
      method: "POST",
      body: JSON.stringify({ personId: "person_9" }),
    }), env);
    expect(denied.status).toBe(403);
    const res = await handleDeletePerson(new Request("https://channels/internal/delete-person", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify({ personId: "person_9" }),
    }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(deleted.sort()).toEqual(["hash-x", "hash-y"]);
    expect(binds.has("person_9")).toBe(false);
    const empty = await handleDeletePerson(new Request("https://channels/internal/delete-person", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify({ personId: "person_nobody" }),
    }), env);
    expect(await empty.json()).toEqual({ deleted: 0 });
  });
});
