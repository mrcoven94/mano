// Guardian against production: the 44 synthetic actions from Guardian's own
// eval (@mano/guardian/eval/cases) sent to the deployed checker, scored
// for precision, recall and latency the same way Guardian's eval scores them.
// Needs MANO_GUARDIAN_URL, MANO_GUARDIAN_TOKEN and the proxy key pair; without
// them the stage says it did not run. Guardian scales to zero, so the stage
// warms it first and waits, the way Mano does when a conversation starts.

import { GlimmerChecker, type Checker } from "@mano/guardian";
import { EVAL_CASES } from "@mano/guardian/eval/cases";
import { percentile } from "./run.ts";

export interface GuardianSummary {
  ran: boolean;
  detail: string;
  cases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  accuracy: number;
  p50Ms: number;
  p95Ms: number;
  warmSeconds: number;
}

const WARM_WAIT_MS = 20 * 60_000;

function flagged(verdict: string): boolean {
  return verdict === "block" || verdict === "fix";
}

export function scoreVerdicts(rows: { expected: "pass" | "block"; verdict: string; ms: number }[], warmSeconds: number, detail: string): GuardianSummary {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const bad = row.expected === "block";
    const caught = flagged(row.verdict);
    if (bad && caught) tp += 1;
    else if (!bad && caught) fp += 1;
    else if (!bad) tn += 1;
    else fn += 1;
  }
  const ms = rows.map((r) => r.ms);
  return {
    ran: true,
    detail,
    cases: rows.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    accuracy: rows.length === 0 ? 0 : (tp + tn) / rows.length,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    warmSeconds,
  };
}

export function notRun(detail: string): GuardianSummary {
  return { ran: false, detail, cases: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: 0, recall: 0, accuracy: 0, p50Ms: 0, p95Ms: 0, warmSeconds: 0 };
}

export async function runGuardian(env: NodeJS.ProcessEnv = process.env, checker?: Checker & { warm?: () => Promise<string> }): Promise<GuardianSummary> {
  const url = env.MANO_GUARDIAN_URL ?? "";
  const token = env.MANO_GUARDIAN_TOKEN ?? "";
  const keyId = env.MANO_GUARDIAN_KEY_ID ?? "";
  const secret = env.MANO_GUARDIAN_KEY_SECRET ?? "";
  if (!checker && (!url || !token)) return notRun("MANO_GUARDIAN_URL or MANO_GUARDIAN_TOKEN is not set");
  const live = checker ?? new GlimmerChecker({ url, token, ...(keyId && secret ? { proxyAuth: { keyId, secret } } : {}) });
  const warmStart = Date.now();
  if (live.warm) {
    let state = await live.warm();
    while (state !== "ready" && Date.now() - warmStart < WARM_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      state = await live.warm();
    }
    if (state !== "ready") return notRun(`Guardian never became ready after ${Math.round((Date.now() - warmStart) / 1000)} s`);
  }
  const warmSeconds = Math.round((Date.now() - warmStart) / 1000);
  const rows: { expected: "pass" | "block"; verdict: string; ms: number }[] = [];
  for (const c of EVAL_CASES) {
    const start = Date.now();
    const result = await live.check(c.input);
    rows.push({ expected: c.expected, verdict: result.verdict, ms: Date.now() - start });
  }
  return scoreVerdicts(rows, warmSeconds, "Guardian's 44-case eval against the deployed checker");
}
