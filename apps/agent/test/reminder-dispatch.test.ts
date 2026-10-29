import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getReminderStore, resetReminderStores } from "../agent/lib/reminder-store.js";
import dispatch from "../agent/schedules/reminder_dispatch.js";
import cancelReminder from "../agent/tools/cancel_reminder.js";
import { toolCtx } from "./ctx.js";

const HANDLE = "a".repeat(64);
const ctx = toolCtx({ handleHash: HANDLE, turnId: "turn_cancel0001" });

function due(id: string, dueAtMs: number) {
  return { id, handleHash: HANDLE, generation: 0, text: id, dueAtMs, createdAtMs: 1, claimedAtMs: null, sentAtMs: null };
}

let delivered: string[];
let onDeliver: (key: string) => Promise<void>;

beforeEach(() => {
  resetReminderStores();
  delivered = [];
  onDeliver = async () => undefined;
  vi.stubEnv("MANO_ENV", "development");
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("MANO_CHANNELS_URL", "http://channels.test");
  vi.stubEnv("MANO_AGENT_SECRET", "dispatch-test-secret");
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    const { key } = JSON.parse(String(init?.body));
    await onDeliver(key);
    delivered.push(key);
    return Response.json({ sent: true });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetReminderStores();
});

describe("reminder dispatch and cancellation", () => {
  it("a reminder cancelled while an earlier one is being delivered is never sent", async () => {
    const store = (await getReminderStore())!;
    const now = Date.now();
    await store.create(due("rem_first", now - 2000));
    await store.create(due("rem_second", now - 1000));
    let cancelled: unknown;
    onDeliver = async (key) => {
      if (key === "rem_first") cancelled = await cancelReminder.execute({ reminderId: "rem_second" }, ctx);
    };
    await (dispatch as unknown as { run: () => Promise<void> }).run();
    expect(cancelled).toMatchObject({ cancelled: true });
    expect(delivered).toEqual(["rem_first"]);
  });

  it("a reminder already on its way is reported as sending, not cancelled", async () => {
    const store = (await getReminderStore())!;
    await store.create(due("rem_only", Date.now() - 1000));
    let cancelled: unknown;
    onDeliver = async () => {
      cancelled = await cancelReminder.execute({ reminderId: "rem_only" }, ctx);
    };
    await (dispatch as unknown as { run: () => Promise<void> }).run();
    expect(delivered).toEqual(["rem_only"]);
    expect(cancelled).toMatchObject({ cancelled: false, alreadySending: true });
  });
});
