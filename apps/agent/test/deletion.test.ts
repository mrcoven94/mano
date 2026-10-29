import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { handleDeleted } from "../agent/lib/deletion.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { loadPending } from "../agent/lib/pending.js";
import { getReminderStore, resetReminderStores } from "../agent/lib/reminder-store.js";
import { getKeyValue, resetKeyValue } from "../agent/lib/storage.js";
import { handleTurn } from "../agent/lib/turn.js";
import remember from "../agent/tools/remember.js";
import remind from "../agent/tools/remind.js";
import startFormDraft from "../agent/tools/start_form_draft.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const SECRET = "deletion-test-secret";
const HANDLE = "d".repeat(64);
const fields = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "555-0100",
  householdSize: 3,
  monthlyIncome: 1800,
};

let engine: EngineDouble;
let grant: string;
let resets: string[];

function signedRequest(path: string, body: unknown): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request(`http://agent.test${path}`, {
    method: "POST",
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

async function deps() {
  return {
    secret: SECRET,
    kv: await getKeyValue(),
    engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch }),
    reminders: await getReminderStore(),
    resetSession: async (handleHash: string) => {
      resets.push(handleHash);
    },
  };
}

beforeEach(async () => {
  engine = new EngineDouble();
  resets = [];
  resetKeyValue();
  resetReminderStores();
  vi.stubEnv("MANO_ENV", "development");
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
  grant = await grantFor(HANDLE);
  const ctx = toolCtx({ handleHash: HANDLE, turnId: "turn_before_del1", grant });
  await remember.execute({ fact: "Lives in Salt Lake County" }, ctx);
  await remind.execute({ text: "call the office", when: "tomorrow at 9" }, ctx);
  await remind.execute({ text: "bring the pay stub", when: "tomorrow at 10" }, ctx);
  await startFormDraft.execute(fields, ctx);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("deleting a conversation", () => {
  it("closes the waiting approval, cancels reminders, deletes memory and retires the session", async () => {
    const res = await handleDeleted(signedRequest("/channels/mano/deleted", { handleHash: HANDLE, generation: 1, grant }), await deps());
    expect(res.status).toBe(200);
    expect(engine.approvals()[0].status).toBe("rejected");
    expect(await loadPending((await getKeyValue())!, personIdFor(HANDLE))).toBeNull();
    expect(await (await getReminderStore())!.listForHandle(HANDLE)).toEqual([]);
    expect(engine.memory.get(personIdFor(HANDLE))).toEqual([]);
    expect(resets).toEqual([HANDLE]);
  });

  it("a repeated notice converges and never retires a newer session", async () => {
    const notice = { handleHash: HANDLE, generation: 1, grant };
    await handleDeleted(signedRequest("/channels/mano/deleted", notice), await deps());
    const again = await handleDeleted(signedRequest("/channels/mano/deleted", notice), await deps());
    expect(again.status).toBe(200);
    expect(resets).toEqual([HANDLE]);
  });

  it("a turn from before the deletion is refused afterwards", async () => {
    await handleDeleted(signedRequest("/channels/mano/deleted", { handleHash: HANDLE, generation: 1, grant }), await deps());
    const stale = await handleTurn(
      signedRequest("/channels/mano/turn", { turnId: "turn_late_old001", generation: 0, handleHash: HANDLE, grant, texts: ["YES"], attachmentCount: 0 }),
      { secret: SECRET, kv: await getKeyValue(), engine: engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch }), runAgent: async () => ({ status: "replied", text: "x", reason: "stop" }) },
    );
    expect(stale.status).toBe(409);
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("rejects an unsigned notice", async () => {
    const forged = new Request("http://agent.test/channels/mano/deleted", {
      method: "POST",
      body: JSON.stringify({ handleHash: HANDLE, generation: 1, grant }),
    });
    expect((await handleDeleted(forged, await deps())).status).toBe(401);
    expect(engine.approvals()[0].status).toBe("pending");
  });
});
