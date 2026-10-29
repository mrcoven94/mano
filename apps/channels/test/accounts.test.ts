import { describe, expect, it } from "vitest";
import { StandInAccountsDirectory, hashHandle, logKeyHash, signInCodeMessage } from "@mano/channels";
import { handleDeletePerson, handleSendCode, routeEvent } from "../src/index.js";
import type { Env } from "../src/env.js";
import { MemoryGlobalStore } from "../src/global.js";
import { TEST_CHANNEL, TEST_HANDLE, inboundEvent, makeHarness, runTurnAfterBatch } from "./helpers.js";

const PEPPER = "test-pepper-not-real";
const SECRET = "test-internal-secret";
const CODE_TEXT = "Your Mano code is 123456. It expires in 10 minutes.";

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
    const first = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-1");
    expect(first.state).toBe("sent");
    expect(first.fresh).toBe(true);
    expect(h.channel.sends).toHaveLength(1);
    expect(h.channel.sends[0].text).toBe(CODE_TEXT);
    const second = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-1");
    expect(second.state).toBe("sent");
    expect(second.fresh).toBe(false);
    expect(h.channel.sends).toHaveLength(1);
  });

  it("builds the exact code text from the digits", async () => {
    const h = makeHarness();
    await h.runner.sendCode(TEST_HANDLE, "654321", "code-key-text");
    expect(h.channel.sends[0].text).toBe(signInCodeMessage("654321"));
    expect(h.channel.sends[0].text).toBe("Your Mano code is 654321. It expires in 10 minutes.");
  });

  it("refuses non-6-digit input without sending", async () => {
    const h = makeHarness();
    for (const [i, bad] of ["12345", "1234567", "abcdef", "12345a", ""].entries()) {
      const refused = await h.runner.sendCode(TEST_HANDLE, bad, `code-key-bad-${i}`);
      expect(refused.state).toBe("refused");
      expect(refused.code).toBe("bad_code");
    }
    expect(h.channel.sends).toHaveLength(0);
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
    const sent = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-2");
    expect(sent.state).toBe("uncertain");
    expect(h.store.outboundByKey("code-key-2")?.state).toBe("uncertain");
    const resolved = await h.runner.resolveUncertain();
    expect(resolved).toBe(1);
    expect(h.store.outboundByKey("code-key-2")?.state).toBe("sent");
  });

  it("reconciles a lost response through the replayed key", async () => {
    const h = makeHarness();
    h.channel.scriptFailure("code-key-3", { kind: "timeout-then-present", messageId: "msg_code_3" });
    const sent = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-3");
    expect(sent.state).toBe("sent");
  });

  it("records refusals and suppresses opted-out conversations", async () => {
    const h = makeHarness();
    h.channel.scriptFailure("code-key-4", { kind: "refuse", status: 403, code: "conversation_closed" });
    const refused = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-4");
    expect(refused.state).toBe("refused");
    expect(refused.code).toBe("conversation_closed");
    const meta = h.store.meta();
    meta.optedOut = true;
    h.store.saveMeta(meta);
    const suppressed = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-5");
    expect(suppressed.state).toBe("refused");
    expect(suppressed.code).toBe("opted_out");
  });

  it("records a definitive failure instead of retrying", async () => {
    const h = makeHarness();
    h.channel.scriptFailure("code-key-6", { kind: "fail", status: 404, code: "chat_not_found" });
    const failed = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-6");
    expect(failed.state).toBe("failed");
    expect(failed.code).toBe("chat_not_found");
    expect(h.store.outboundByKey("code-key-6")?.state).toBe("failed");
    expect(await h.runner.resolveUncertain()).toBe(0);
    expect(h.channel.sends).toHaveLength(0);
    const replayed = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-6");
    expect(replayed.state).toBe("failed");
    expect(replayed.fresh).toBe(false);
  });
});

describe("code limits", () => {
  it("refuses the 4th code to one phone within the hour, then allows the next hour", async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) {
      const sent = await h.runner.sendCode(TEST_HANDLE, "123456", `code-key-hour-${i}`);
      expect(sent.state).toBe("sent");
    }
    const limited = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-hour-3");
    expect(limited.state).toBe("refused");
    expect(limited.code).toBe("code_limit_phone");
    expect(h.channel.sends).toHaveLength(3);
    h.advance(3600_000 + 1000);
    const next = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-hour-4");
    expect(next.state).toBe("sent");
  });

  it("blocks on the global cap with a distinct code", async () => {
    const h = makeHarness({ codeBudget: 2 });
    expect((await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-g1")).state).toBe("sent");
    expect((await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-g2")).state).toBe("sent");
    const limited = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-g3");
    expect(limited.state).toBe("refused");
    expect(limited.code).toBe("code_limit_global");
    expect(h.channel.sends).toHaveLength(2);
  });

  it("never consumes reply budget with code sends", async () => {
    const h = makeHarness();
    await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-b1");
    await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-b2");
    const meta = h.store.meta();
    expect(meta.hourCount).toBe(0);
    expect(meta.dayCount).toBe(0);
    expect(h.ledger.spent().spentUsd).toBe(0);
    await h.runner.handleEvent(inboundEvent({ id: "evt_budget_1", text: "Hi.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(0);
  });
});

describe("code STOP handling", () => {
  async function seedUncertainCode(h: ReturnType<typeof makeHarness>, key: string): Promise<void> {
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
    const sent = await h.runner.sendCode(TEST_HANDLE, "123456", key);
    expect(sent.state).toBe("uncertain");
    h.channel.send = inner;
  }

  it("refuses a retry after opt-out without another send", async () => {
    const h = makeHarness();
    await seedUncertainCode(h, "code-key-stop-1");
    const meta = h.store.meta();
    meta.optedOut = true;
    h.store.saveMeta(meta);
    const sendsBefore = h.channel.sends.length;
    const retried = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-stop-1");
    expect(retried.state).toBe("refused");
    expect(retried.code).toBe("opted_out");
    expect(h.channel.sends.length).toBe(sendsBefore);
  });

  it("suppresses recovery after opt-out or close instead of replaying", async () => {
    for (const flag of ["optedOut", "closed"] as const) {
      const h = makeHarness();
      await seedUncertainCode(h, `code-key-stop-${flag}`);
      const meta = h.store.meta();
      meta[flag] = true;
      h.store.saveMeta(meta);
      const sendsBefore = h.channel.sends.length;
      expect(await h.runner.resolveUncertain()).toBe(1);
      expect(h.store.outboundByKey(`code-key-stop-${flag}`)).toMatchObject({
        state: "refused",
        code: flag === "closed" ? "conversation_closed" : "opted_out",
      });
      expect(h.channel.sends.length).toBe(sendsBefore);
    }
  });
});

describe("code recovery", () => {
  it("replays an uncertain code to its stored recipient", async () => {
    const h = makeHarness();
    expect(h.store.meta().to).toBeNull();
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
    const sent = await h.runner.sendCode(TEST_HANDLE, "123456", "code-key-rec-1");
    expect(sent.state).toBe("uncertain");
    expect(h.store.outboundByKey("code-key-rec-1")?.to).toBe(TEST_HANDLE);
    expect(await h.runner.resolveUncertain()).toBe(1);
    expect(h.store.outboundByKey("code-key-rec-1")?.state).toBe("sent");
    expect(h.channel.sends).toHaveLength(1);
    expect(h.channel.sends[0].to).toBe(TEST_HANDLE);
    expect(h.channel.sends[0].text).toBe(CODE_TEXT);
  });
});

describe("code privacy", () => {
  it("never logs the raw key, code, or phone on the code path", async () => {
    const h = makeHarness();
    const key = "SENTINEL-KEY-9f8e7d";
    await h.runner.sendCode(TEST_HANDLE, "987654", key);
    h.channel.scriptFailure("SENTINEL-KEY-refuse", { kind: "refuse", status: 403, code: "conversation_closed" });
    await h.runner.sendCode(TEST_HANDLE, "987654", "SENTINEL-KEY-refuse");
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
    await h.runner.sendCode(TEST_HANDLE, "987654", "SENTINEL-KEY-uncertain");
    const logs = h.lines.join("\n");
    expect(logs).not.toContain("SENTINEL-KEY-9f8e7d");
    expect(logs).not.toContain("SENTINEL-KEY-refuse");
    expect(logs).not.toContain("SENTINEL-KEY-uncertain");
    expect(logs).not.toContain("SENTINEL");
    expect(logs).not.toContain("987654");
    expect(logs).not.toContain(TEST_HANDLE);
    expect(logs).not.toContain("Your Mano code is 987654. It expires in 10 minutes.");
    expect(logs).toContain(logKeyHash(key));
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

  it("clears only the given handles, keeping the rest for retry", async () => {
    const store = new MemoryGlobalStore();
    store.notePersonBind("hash-a", "person_1");
    store.notePersonBind("hash-b", "person_1");
    store.clearPersonHandles("person_1", ["hash-a"]);
    expect(store.handlesForPerson("person_1")).toEqual(["hash-b"]);
  });
});

describe("service routes", () => {
  it("send-code needs the internal secret and forwards digits plus person to the conversation", async () => {
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
    const body = { to: TEST_HANDLE, code: "123456", idempotencyKey: "code-key-9" };
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
    const forwarded = calls[0].body as { to: string; code: string; idempotencyKey: string; personId: string };
    expect(forwarded.to).toBe(TEST_HANDLE);
    expect(forwarded.code).toBe("123456");
    expect(forwarded.idempotencyKey).toBe("code-key-9");
    expect(forwarded.personId).toBe((await new StandInAccountsDirectory(PEPPER).resolvePerson(TEST_HANDLE)).personId);
    expect(calls[0].body).not.toHaveProperty("message");
  });

  it("send-code rejects non-6-digit codes without calling the conversation", async () => {
    let calls = 0;
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async () => {
          calls += 1;
          return Response.json({ key: "x", state: "sent", code: null });
        },
      }),
    };
    const env = { ...baseEnv(), CONVERSATION: ns } as unknown as Env;
    for (const code of ["12345", "1234567", "abcdef", ""]) {
      const res = await handleSendCode(new Request("https://channels/internal/send-code", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ to: TEST_HANDLE, code, idempotencyKey: "code-key-bad" }),
      }), env);
      expect(res.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  it("rejects internal routes on the public hostname even with the secret", async () => {
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async () => Response.json({ key: "x", state: "sent", code: null }),
      }),
    };
    const env = { ...baseEnv(), CONVERSATION: ns } as unknown as Env;
    const send = await handleSendCode(new Request("https://text.withmano.com/internal/send-code", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify({ to: TEST_HANDLE, code: "123456", idempotencyKey: "code-key-pub" }),
    }), env);
    expect(send.status).toBe(403);
    const del = await handleDeletePerson(new Request("https://text.withmano.com/internal/delete-person", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify({ personId: "person_9" }),
    }), env);
    expect(del.status).toBe(403);
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
        const unbound = JSON.parse(String(init?.body ?? "{}")) as { personId: string; handleHashes?: string[] };
        const kept = (binds.get(unbound.personId) ?? []).filter((h) => !(unbound.handleHashes ?? []).includes(h));
        if (kept.length > 0) binds.set(unbound.personId, kept);
        else binds.delete(unbound.personId);
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
    expect(await res.json()).toEqual({ deleted: 2, failed: 0 });
    expect(deleted.sort()).toEqual(["hash-x", "hash-y"]);
    expect(binds.has("person_9")).toBe(false);
    const empty = await handleDeletePerson(new Request("https://channels/internal/delete-person", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify({ personId: "person_nobody" }),
    }), env);
    expect(await empty.json()).toEqual({ deleted: 0, failed: 0 });
  });

  it("delete-person fails when a wipe fails and keeps the binding for retry", async () => {
    const binds = new Map([["person_9", ["hash-x", "hash-y"]]]);
    const failures = new Map([["hash-y", 1]]);
    const convNs = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async () => {
          if ((failures.get(id.name) ?? 0) > 0) return new Response("Down.", { status: 500 });
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
        const unbound = JSON.parse(String(init?.body ?? "{}")) as { personId: string; handleHashes?: string[] };
        const kept = (binds.get(unbound.personId) ?? []).filter((h) => !(unbound.handleHashes ?? []).includes(h));
        if (kept.length > 0) binds.set(unbound.personId, kept);
        else binds.delete(unbound.personId);
        return Response.json({ ok: true });
      },
    };
    const env = {
      ...baseEnv(),
      CONVERSATION: convNs,
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stateStub },
    } as unknown as Env;
    const authed = (personId: string) => new Request("https://channels/internal/delete-person", {
      method: "POST",
      headers: { "x-mano-internal": SECRET },
      body: JSON.stringify({ personId }),
    });
    const first = await handleDeletePerson(authed("person_9"), env);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ deleted: 1, failed: 1 });
    expect(binds.get("person_9")).toEqual(["hash-y"]);
    failures.set("hash-y", 0);
    const retry = await handleDeletePerson(authed("person_9"), env);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deleted: 1, failed: 0 });
    expect(binds.has("person_9")).toBe(false);
  });
});
