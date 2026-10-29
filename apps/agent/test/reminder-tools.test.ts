import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getReminderStore, resetReminderStores } from "../agent/lib/reminder-store.js";
import remind from "../agent/tools/remind.js";
import { toolCtx } from "./ctx.js";

const HANDLE = "b".repeat(64);

function ctx(turnId: string) {
  return toolCtx({ handleHash: HANDLE, turnId, generation: 4 });
}

beforeEach(() => {
  resetReminderStores();
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
  vi.stubEnv("VERCEL_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetReminderStores();
});

describe("reminder storage", () => {
  it("refuses to set a reminder when durable storage is missing outside local development", async () => {
    vi.stubEnv("MANO_ENV", "");
    await expect(remind.execute({ text: "call the county", when: "tomorrow at 9" }, ctx("turn_aaaaaaaa1"))).rejects.toThrow(
      /not available/i,
    );
  });

  it("refuses memory storage on a production deployment even if development is claimed", async () => {
    vi.stubEnv("MANO_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(remind.execute({ text: "call the county", when: "tomorrow at 9" }, ctx("turn_aaaaaaaa2"))).rejects.toThrow(
      /not available/i,
    );
  });

  it("keeps reminders in memory in explicit local development", async () => {
    vi.stubEnv("MANO_ENV", "development");
    const out = await remind.execute({ text: "call the county", when: "tomorrow at 9" }, ctx("turn_aaaaaaaa3"));
    expect(out).toMatchObject({ text: "call the county" });
    const store = await getReminderStore();
    const [saved] = await store!.listForHandle(HANDLE);
    expect(saved.generation).toBe(4);
  });
});

describe("reminders keyed by turn", () => {
  it("a replayed or recovered turn never creates a second reminder", async () => {
    vi.stubEnv("MANO_ENV", "development");
    const input = { text: "call the county", when: "tomorrow at 9" };
    const first = await remind.execute(input, ctx("turn_replay0001"));
    const again = await remind.execute(input, ctx("turn_replay0001"));
    expect(again).toEqual(first);
    const store = await getReminderStore();
    expect(await store!.listForHandle(HANDLE)).toHaveLength(1);
  });

  it("two different reminders at the same time in one turn are both kept", async () => {
    vi.stubEnv("MANO_ENV", "development");
    await remind.execute({ text: "call the office", when: "tomorrow at 9" }, ctx("turn_pair000001"));
    await remind.execute({ text: "bring the pay stub", when: "tomorrow at 9" }, ctx("turn_pair000001"));
    const store = await getReminderStore();
    expect((await store!.listForHandle(HANDLE)).map((r) => r.text).sort()).toEqual(["bring the pay stub", "call the office"]);
  });

  it("a different turn sets its own reminder", async () => {
    vi.stubEnv("MANO_ENV", "development");
    const input = { text: "call the county", when: "tomorrow at 9" };
    await remind.execute(input, ctx("turn_first00001"));
    await remind.execute(input, ctx("turn_second0001"));
    const store = await getReminderStore();
    expect(await store!.listForHandle(HANDLE)).toHaveLength(2);
  });

  it("a turn without an ID cannot set a reminder", async () => {
    vi.stubEnv("MANO_ENV", "development");
    const noTurn = { session: { auth: { current: { principalId: HANDLE, attributes: {} } } } } as never;
    await expect(remind.execute({ text: "call the county", when: "tomorrow at 9" }, noTurn)).rejects.toThrow();
  });
});
