/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlConversationStore } from "../src/store-sql.js";
import { inboundEvent, makeHarness } from "./helpers.js";

// Sol's review 8: a turn run awaits a presentation report; STOP arrives
// during that await; the run then saved the meta it read before the await
// and undid the STOP. Runs the real runner handlers on the real SQL store.
function sqliteStorage(db: DatabaseSync): SqlStorage {
  return {
    exec(sql: string, ...params: unknown[]) {
      const select = /^\s*(SELECT|WITH)\b/i.test(sql);
      if (!select && params.length === 0 && sql.includes(";")) {
        db.exec(sql);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(sql);
      const args = params as SQLInputValue[];
      if (select) return { toArray: () => stmt.all(...args) };
      stmt.run(...args);
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
}

const QUESTION = "Ready to send: renewal. Reply YES to send exactly this, or NO to stop.";

describe("STOP while a presentation report is in flight", () => {
  it("holds: the run never writes back what it read before the await, and nothing is sent afterward", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    let reporting: () => void = () => undefined;
    const inFlight = new Promise<void>((r) => (reporting = r));
    const h = makeHarness({
      store: new SqlConversationStore(sqliteStorage(new DatabaseSync(":memory:"))),
      responder: {
        name: "agent",
        maxAttempts: 1,
        respond: async () => ({
          text: QUESTION,
          bubbles: [QUESTION],
          inputChars: 10,
          outputChars: QUESTION.length,
          model: "agent",
          attempts: 1,
          presentation: { approvalId: "appr_1", approval: QUESTION },
        }),
      },
      reportPresentation: async () => {
        calls += 1;
        // The first report fails; the retry hangs until the test lets it go.
        if (calls === 1) throw new Error("agent unreachable");
        if (calls === 2) {
          reporting();
          await new Promise<void>((r) => (release = r));
        }
        return true;
      },
    });
    const meta = h.store.meta();
    meta.introduced = true;
    h.store.saveMeta(meta);

    await h.runner.handleEvent(inboundEvent({ id: "evt_q", text: "file it", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    expect(await h.runner.runDueTurn()).toBe("retry");

    // A new message and the person's typing wait for the next run.
    await h.runner.handleEvent(inboundEvent({ id: "evt_more", text: "one more thing", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_typing", kind: "typing.started", text: null, occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_typed", kind: "typing.stopped", text: null, occurredAtMs: h.now }), "webhook");
    h.advance(60_000);
    const run = h.runner.runDueTurn();
    await inFlight;
    // STOP lands while the run awaits the report.
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook")).toBe("opted-out");
    const sentBefore = h.channel.sends.length;
    release();
    await run;

    expect(h.store.meta().optedOut).toBe(true);
    expect(h.channel.sends.slice(sentBefore).map((s) => s.text)).toEqual([]);
    h.advance(60_000);
    await h.runner.runDueTurn();
    expect(await h.runner.sendAgentText({ key: "reminder:after-stop", text: "Reminder: call the office", generation: 0 })).toEqual({
      sent: false,
      reason: "opted_out",
    });
    expect(h.channel.sends.slice(sentBefore).map((s) => s.text)).toEqual([]);
    expect(h.store.meta().optedOut).toBe(true);
  });

  it("a send left uncertain before STOP is never replayed after it", async () => {
    const h = makeHarness({ store: new SqlConversationStore(sqliteStorage(new DatabaseSync(":memory:"))) });
    const meta = h.store.meta();
    meta.introduced = true;
    h.store.saveMeta(meta);
    const realSend = h.channel.send.bind(h.channel);
    let down = true;
    h.channel.send = async (input) => {
      if (down) throw new Error("provider unreachable");
      return realSend(input);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_unsure", text: "hello", occurredAtMs: h.now }), "webhook");
    h.advance(5000);
    await h.runner.runDueTurn();
    expect(h.store.outbounds().some((r) => r.state === "uncertain")).toBe(true);
    down = false;
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_stop2", text: "STOP", occurredAtMs: h.now }), "webhook")).toBe("opted-out");
    const sentBefore = h.channel.sends.length;
    await h.runner.resolveUncertain();
    expect(h.channel.sends.slice(sentBefore)).toEqual([]);
    expect(h.store.outbounds().filter((r) => r.state === "uncertain")).toEqual([]);
  });
});
