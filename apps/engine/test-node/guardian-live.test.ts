/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { GlimmerModelChecker } from "@mano/guardian";
import {
  ActionGateway,
  InMemoryExecutor,
  SqlApprovalStore,
  checkerSetting,
  ensureGatewayTables,
  gatewayChecker,
} from "../src/gateway/index.js";

// Maria's synthetic renewal through the gateway against the deployed
// Guardian. Opt in with MANO_GUARDIAN_LIVE=1 and the four MANO_GUARDIAN_*
// names from the vault:
//   MANO_GUARDIAN_LIVE=1 ws keys run -- pnpm --filter @mano/engine exec vitest run --config vitest.node.config.ts test-node/guardian-live.test.ts
// It warms Guardian first and waits for it, then prints the status,
// problems and time. It never prints a key.

const live = process.env.MANO_GUARDIAN_LIVE === "1";

function openStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
}

describe.skipIf(!live)("Guardian live", () => {
  it("checks Maria's synthetic renewal before the yes", async () => {
    const setting = checkerSetting(process.env);
    expect(setting.kind).toBe("guardian");
    if (setting.kind !== "guardian") return;

    const warmer = new GlimmerModelChecker({ url: setting.url, token: setting.token, ...(setting.proxyAuth ? { proxyAuth: setting.proxyAuth } : {}) });
    const warmStart = Date.now();
    let state = await warmer.warm();
    while (state !== "ready" && Date.now() - warmStart < 10 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      state = await warmer.warm();
    }
    expect(state).toBe("ready");

    const storage = openStorage();
    ensureGatewayTables(storage as never);
    const gateway = new ActionGateway(new SqlApprovalStore(storage as never), new InMemoryExecutor(), {
      ...gatewayChecker(setting),
      linkCheck: async () => ({ allowed: true }),
    });
    const started = Date.now();
    const result = await gateway.requestAction({
      type: "submit",
      recipient: "sandbox-agency-portal",
      purpose: "Food benefits renewal in the sandbox agency portal",
      payload: { fullName: "Maria Synthetic", dateOfBirth: "1990-01-01", householdSize: 3, monthlyIncome: 1200 },
      idempotencyKey: `guardian-live-${crypto.randomUUID()}`,
      actor: "foreground",
      personId: "maria-synthetic",
      sources: [],
      origin: "person",
    });
    console.log(
      JSON.stringify({
        warmSeconds: Math.round((started - warmStart) / 1000),
        checkMs: Date.now() - started,
        status: result.status,
        problems: result.approval?.problems ?? null,
        reason: result.reason ?? null,
      }),
    );
    expect(result.status).toBe("needs_approval");
  }, 12 * 60_000);
});
