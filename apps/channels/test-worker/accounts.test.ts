import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { StandInAccountsDirectory, hashHandle } from "@mano/channels";
import worker from "../src/index.js";
import { GLOBAL_STATE_ID } from "../src/conversation.js";
import type { Env } from "../src/env.js";

const workerEnv = env as unknown as Env;
const SECRET = "test-internal-secret-not-real";
const PEPPER = "test-pepper-not-real";

function convStub(name: string): DurableObjectStub {
  return workerEnv.CONVERSATION.get(workerEnv.CONVERSATION.idFromName(name));
}

function stateStub(): DurableObjectStub {
  return workerEnv.CHANNEL_STATE.get(workerEnv.CHANNEL_STATE.idFromName(GLOBAL_STATE_ID));
}

function inbound(id: string, handle: string): Record<string, unknown> {
  return {
    id,
    kind: "message.received",
    rawType: "message.received",
    channelId: "ch_test_line",
    channelType: "blooio",
    chatId: `chat_${id}`,
    messageId: `msg_${id}`,
    handle,
    direction: "inbound",
    text: "Hello.",
    attachments: [],
    errorCode: null,
    errorMessage: null,
    occurredAtMs: Date.now(),
  };
}

async function personHandles(personId: string): Promise<string[]> {
  const res = await stateStub().fetch(
    `https://state/internal/person-handles?person=${encodeURIComponent(personId)}`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { handleHashes: string[] }).handleHashes;
}

describe("accounts on real storage", () => {
  it("binds a handle to its person once", async () => {
    const tag = `acct-bind-${Date.now()}`;
    const stub = convStub(tag);
    const personId = `person_${tag}`;
    const first = await stub.fetch("https://conversation/internal/event", {
      method: "POST",
      body: JSON.stringify({ handleHash: tag, personId, event: inbound(`evt_${tag}_1`, "+15550001001") }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ result: "queued", personCreated: true });
    const second = await stub.fetch("https://conversation/internal/event", {
      method: "POST",
      body: JSON.stringify({ handleHash: tag, personId, event: inbound(`evt_${tag}_2`, "+15550001001") }),
    });
    expect(await second.json()).toMatchObject({ personCreated: false });
    expect(await personHandles(personId)).toEqual([tag]);
  });

  it("sends a code through the conversation outbox", async () => {
    const tag = `acct-code-${Date.now()}`;
    const stub = convStub(tag);
    const res = await stub.fetch("https://conversation/internal/send-code", {
      method: "POST",
      body: JSON.stringify({
        handleHash: tag,
        to: "+15550001002",
        code: "123456",
        idempotencyKey: `code-${tag}`,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: `code-${tag}`, state: "sent" });
    const standin = await stub.fetch("https://conversation/internal/standin");
    expect(standin.status).toBe(200);
    const recorded = (await standin.json()) as { sends: Array<{ key: string; state: string }> };
    expect(recorded.sends).toContainEqual(expect.objectContaining({ key: `code-${tag}`, state: "sent" }));
  });

  it("rejects non-6-digit codes at the worker and the conversation", async () => {
    const tag = `acct-badcode-${Date.now()}`;
    const res = await worker.fetch(
      new Request("https://channels/internal/send-code", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ to: "+15550001002", code: "12ab", idempotencyKey: `code-${tag}` }),
      }),
      workerEnv,
    );
    expect(res.status).toBe(400);
    const direct = await convStub(tag).fetch("https://conversation/internal/send-code", {
      method: "POST",
      body: JSON.stringify({ handleHash: tag, to: "+15550001002", code: "12345", idempotencyKey: `code-${tag}` }),
    });
    expect(direct.status).toBe(400);
  });

  it("rejects the service routes on the public hostname even with the secret", async () => {
    const send = await worker.fetch(
      new Request("https://text.withmano.com/internal/send-code", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ to: "+15550001002", code: "123456", idempotencyKey: "code-pub" }),
      }),
      workerEnv,
    );
    expect(send.status).toBe(403);
    const del = await worker.fetch(
      new Request("https://text.withmano.com/internal/delete-person", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ personId: "person_pub" }),
      }),
      workerEnv,
    );
    expect(del.status).toBe(403);
  });

  it("deletes a code-only conversation through its first-send bind", async () => {
    const handle = "+15550001004";
    const tag = `acct-codeonly-${Date.now()}`;
    const send = await worker.fetch(
      new Request("https://channels/internal/send-code", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ to: handle, code: "123456", idempotencyKey: `code-${tag}` }),
      }),
      workerEnv,
    );
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ key: `code-${tag}`, state: "sent", personCreated: true });
    const personId = (await new StandInAccountsDirectory(PEPPER).resolvePerson(handle)).personId;
    const handleHash = await hashHandle(handle, PEPPER);
    expect(await personHandles(personId)).toEqual([handleHash]);
    const del = await worker.fetch(
      new Request("https://channels/internal/delete-person", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ personId }),
      }),
      workerEnv,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: 1, failed: 0 });
    expect(await personHandles(personId)).toEqual([]);
    const standin = await convStub(handleHash).fetch("https://conversation/internal/standin");
    const recorded = (await standin.json()) as { sends: unknown[] };
    expect(recorded.sends).toEqual([]);
  });

  it("deletes every conversation a person owns", async () => {
    const tag = `acct-del-${Date.now()}`;
    const personId = `person_${tag}`;
    for (const suffix of ["a", "b"]) {
      const hash = `${tag}-${suffix}`;
      const res = await convStub(hash).fetch("https://conversation/internal/event", {
        method: "POST",
        body: JSON.stringify({ handleHash: hash, personId, event: inbound(`evt_${hash}`, "+15550001003") }),
      });
      expect(res.status).toBe(200);
    }
    expect((await personHandles(personId)).sort()).toEqual([`${tag}-a`, `${tag}-b`].sort());
    const denied = await worker.fetch(
      new Request("https://channels/internal/delete-person", {
        method: "POST",
        body: JSON.stringify({ personId }),
      }),
      workerEnv,
    );
    expect(denied.status).toBe(403);
    const res = await worker.fetch(
      new Request("https://channels/internal/delete-person", {
        method: "POST",
        headers: { "x-mano-internal": SECRET },
        body: JSON.stringify({ personId }),
      }),
      workerEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, failed: 0 });
    expect(await personHandles(personId)).toEqual([]);
    const standin = await convStub(`${tag}-a`).fetch("https://conversation/internal/standin");
    const recorded = (await standin.json()) as { sends: unknown[]; pending: number };
    expect(recorded.sends).toEqual([]);
    expect(recorded.pending).toBe(0);
  });
});
