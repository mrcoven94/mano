import { describe, expect, it, vi } from "vitest";
import { AuthError, UnreconciledSendError, type ChatMessage, type ManoClient, type Session } from "../lib/api/types";
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

  it("reports held sends instead of retrying them", async () => {
    const outbox = new Outbox(new MemoryStore());
    const { client } = stubClient(async (opId) => {
      throw new UnreconciledSendError(opId ?? null);
    });
    const report = await submitMessage(client, sessionFor("alice"), outbox, "hi", []);
    expect(report.sent).toHaveLength(0);
    expect(report.held).toEqual([report.opId]);
    const pending = await outbox.list();
    expect(pending[0]?.held).toBe(true);
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

  describe("crisis help on the device", () => {
    const CRISIS = "I want to kill myself";

    it("shows 988 and 911 when a held send keeps the message from the server", async () => {
      const { client, mock } = stubClient(async () => ({ id: "x" }));
      const outbox = new Outbox(new MemoryStore());
      const session = sessionFor("alice");
      const held = await outbox.enqueue(session.personId, "earlier", []);
      await outbox.flush(session, () => Promise.reject(new UnreconciledSendError(held.id)));
      mock.mockClear();

      const replies: ChatMessage[] = [];
      const report = await submitMessage(client, session, outbox, CRISIS, [], (r) => replies.push(r));
      expect(mock).not.toHaveBeenCalled();
      expect(report.sent).toHaveLength(0);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.role).toBe("agent");
      expect(replies[0]?.text).toMatch(/988[\s\S]*911/);
    });

    it("shows them with no network and with an expired session", async () => {
      const replies: ChatMessage[] = [];
      const down = stubClient(() => Promise.reject(new Error("offline")));
      await submitMessage(down.client, sessionFor("alice"), new Outbox(new MemoryStore()), CRISIS, [], (r) => replies.push(r));
      expect(replies).toHaveLength(1);
      const expired = { ...sessionFor("alice"), expiresAt: new Date(Date.now() - 1000).toISOString() };
      await expect(submitMessage(down.client, expired, new Outbox(new MemoryStore()), CRISIS, [], (r) => replies.push(r))).rejects.toBeInstanceOf(AuthError);
      expect(replies).toHaveLength(2);
    });

    it("dates the line after the message that prompted it, so it reads in order", async () => {
      const { client } = stubClient(() => Promise.reject(new Error("offline")));
      const outbox = new Outbox(new MemoryStore());
      const replies: ChatMessage[] = [];
      await submitMessage(client, sessionFor("alice"), outbox, CRISIS, [], (r) => replies.push(r));
      const [queued] = await outbox.list();
      expect(new Date(replies[0]?.createdAt ?? 0).getTime()).toBeGreaterThan(new Date(queued?.createdAt ?? Infinity).getTime());
    });

    it("adds nothing for an ordinary message", async () => {
      const { client } = stubClient(async () => ({ id: "x" }));
      const replies: ChatMessage[] = [];
      await submitMessage(client, sessionFor("alice"), new Outbox(new MemoryStore()), "Hi", [], (r) => replies.push(r));
      expect(replies.every((r) => !/988/.test(r.text))).toBe(true);
    });
  });
});
