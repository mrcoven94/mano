import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { personIdFor } from "../agent/lib/engine.js";
import cancelReminder from "../agent/tools/cancel_reminder.js";
import listReminders from "../agent/tools/list_reminders.js";
import remind from "../agent/tools/remind.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "b".repeat(64);
const PERSON = personIdFor(HANDLE);
let engine: EngineDouble;
let grant: string;

function ctx(turnId: string) {
  return toolCtx({ handleHash: HANDLE, turnId, grant, generation: 0 });
}

beforeEach(async () => {
  engine = new EngineDouble();
  grant = await grantFor(HANDLE);
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reminders in Engine", () => {
  it("sets a reminder under the turn's deletion generation", async () => {
    const out = await remind.execute({ text: "call the county", when: "tomorrow at 9" }, ctx("turn_aaaaaaaa3"));
    expect(out).toMatchObject({ text: "call the county" });
    const [saved] = engine.remindersOf(PERSON);
    expect(saved).toMatchObject({ text: "call the county", generation: 0, status: "scheduled" });
  });

  it("refuses when Engine is not configured", async () => {
    vi.stubEnv("ENGINE_URL", "");
    await expect(remind.execute({ text: "call the county", when: "tomorrow at 9" }, ctx("turn_aaaaaaaa1"))).rejects.toThrow(/not available/i);
  });

  it("a replayed or recovered turn never creates a second reminder", async () => {
    const input = { text: "call the county", when: "tomorrow at 9" };
    const first = await remind.execute(input, ctx("turn_replay0001"));
    const again = await remind.execute(input, ctx("turn_replay0001"));
    expect(again).toEqual(first);
    expect(engine.remindersOf(PERSON)).toHaveLength(1);
  });

  it("two different reminders at the same time in one turn are both kept", async () => {
    await remind.execute({ text: "call the office", when: "tomorrow at 9" }, ctx("turn_pair000001"));
    await remind.execute({ text: "bring the pay stub", when: "tomorrow at 9" }, ctx("turn_pair000001"));
    expect(engine.remindersOf(PERSON).map((r) => r.text).sort()).toEqual(["bring the pay stub", "call the office"]);
  });

  it("a turn without an ID cannot set a reminder", async () => {
    const noTurn = { session: { auth: { current: { principalId: HANDLE, attributes: { grant, generation: "0" } } } } } as never;
    await expect(remind.execute({ text: "call the county", when: "tomorrow at 9" }, noTurn)).rejects.toThrow();
  });
});

describe("cancelling", () => {
  it("a cancelled reminder is never delivered", async () => {
    const out = (await remind.execute({ text: "call the office", when: "in 2 minutes" }, ctx("turn_cancel0001"))) as { reminderId: string };
    expect(await cancelReminder.execute({ reminderId: out.reminderId }, ctx("turn_cancel0002"))).toMatchObject({ cancelled: true });
    engine.now = () => Date.now() + 10 * 60_000;
    expect(engine.deliverDue(PERSON)).toEqual([]);
    expect((await listReminders.execute({}, ctx("turn_cancel0003"))) as { reminders: unknown[] }).toEqual({ reminders: [] });
  });

  it("one already claimed for delivery is reported as on its way, not cancelled", async () => {
    const out = (await remind.execute({ text: "call the office", when: "in 2 minutes" }, ctx("turn_cancel0004"))) as { reminderId: string };
    engine.now = () => Date.now() + 10 * 60_000;
    expect(engine.deliverDue(PERSON).map((r) => r.id)).toEqual([out.reminderId]);
    expect(await cancelReminder.execute({ reminderId: out.reminderId }, ctx("turn_cancel0005"))).toMatchObject({
      cancelled: false,
      alreadySending: true,
    });
  });
});
