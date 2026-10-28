import { describe, expect, it, vi } from "vitest";
import { AuthError, type ManoClient, type Session } from "../lib/api/types";
import { MemoryStore } from "../lib/kv";
import { Outbox } from "../lib/queue";
import { submitMessage } from "../lib/send";

function sessionFor(personId: string, expiresAt = new Date(Date.now() + 3600_000).toISOString()): Session {
  return { token: `token-${personId}`, personId, email: `${personId}@example.com`, displayName: personId, expiresAt };
}

function stubClient(send: (opId?: string) => Promise<{ id: string }>): {
  client: ManoClient;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (_session: unknown, _text: unknown, _atts: unknown, opId?: string) => send(opId));
  return { client: { sendMessage: mock } as unknown as ManoClient, mock };
}

describe("submitMessage", () => {
  it("queues first, then sends in order with a stable operation ID", async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue("alice", "first", []);
    const seen: (string | undefined)[] = [];
    const { client } = stubClient(async (opId) => {
      seen.push(opId);
      return { id: `reply-${seen.length}` };
    });
    const report = await submitMessage(client, sessionFor("alice"), outbox, "second", []);
    expect(report.sent).toHaveLength(2);
    expect(report.kept).toHaveLength(0);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeTruthy();
    expect(seen[1]).toBe(report.opId);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("refuses an expired session without queueing", async () => {
    const outbox = new Outbox(new MemoryStore());
    const { client, mock } = stubClient(async () => ({ id: "r" }));
    const expired = sessionFor("alice", new Date(Date.now() - 1000).toISOString());
    await expect(submitMessage(client, expired, outbox, "hi", [])).rejects.toBeInstanceOf(AuthError);
    expect(await outbox.list()).toHaveLength(0);
    expect(mock).not.toHaveBeenCalled();
  });

  it("drops the item and surfaces auth errors from the flush", async () => {
    const outbox = new Outbox(new MemoryStore());
    const { client } = stubClient(async () => {
      throw new AuthError();
    });
    await expect(submitMessage(client, sessionFor("alice"), outbox, "hi", [])).rejects.toBeInstanceOf(AuthError);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("reuses the same operation ID across a retry", async () => {
    const outbox = new Outbox(new MemoryStore());
    const seen: (string | undefined)[] = [];
    let fails = 1;
    const { client } = stubClient(async (opId) => {
      seen.push(opId);
      if (fails > 0) {
        fails -= 1;
        throw new Error("offline");
      }
      return { id: "reply" };
    });
    const session = sessionFor("alice");
    const first = await submitMessage(client, session, outbox, "hi", []);
    expect(first.kept).toHaveLength(1);
    const second = await submitMessage(client, session, outbox, "hi again", []);
    expect(second.sent).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).toBe(second.opId);
  });
});
