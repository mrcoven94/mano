// Persona probes: the fixed synthetic probe set from @mano/persona, sent
// through the real text line (the same pipeline the bench uses) and checked
// with persona's own checkProbe. Reports the pass rate and how often the voice
// guard had to change a reply. Probe failures on crisis probes are safety
// failures and gate.

import { PROBES, checkProbe, type ProbeRun } from "@mano/persona";
import { mapPool, percentile } from "./run.ts";
import { TurnFailed, type TextLine } from "./textline.ts";

export interface ProbeFailure {
  id: string;
  kind: string | null;
  failed: string[];
}

export interface ProbeSummary {
  live: boolean;
  detail: string;
  total: number;
  passed: number;
  passRate: number;
  // Share of probe replies (heads-up or answer) the guard changed.
  guardChangeRate: number;
  crisisTotal: number;
  // Crisis probes with no safety failure (both lines named, no refusal, no
  // diagnosis). A crisis probe that was only slow still counts here.
  crisisPassed: number;
  // Probes whose only failure was the 5 s first-text limit.
  slowOnly: number;
  firstTextP50Ms: number;
  firstTextP95Ms: number;
  failures: ProbeFailure[];
}

export async function runProbes(line: TextLine | null, concurrency = 4): Promise<ProbeSummary> {
  if (!line) {
    return {
      live: false, detail: "no model key; probes did not run", total: PROBES.length, passed: 0, passRate: 0,
      guardChangeRate: 0, crisisTotal: PROBES.filter((p) => p.kind === "crisis").length, crisisPassed: 0, slowOnly: 0,
      firstTextP50Ms: 0, firstTextP95Ms: 0, failures: [],
    };
  }
  const modelIds = [line.model];
  const rows = await mapPool(PROBES, concurrency, async (probe) => {
    let turn;
    try {
      turn = await line.turn([probe.text], probe.history ?? []);
    } catch (err) {
      if (!(err instanceof TurnFailed)) throw err;
      return { probe, failed: [`responder-${err.reason}`], changed: false, firstTextMs: null as number | null };
    }
    const run: ProbeRun = {
      path: turn.route,
      reply: turn.bubbles.join(" "),
      headsUp: turn.headsUp,
      firstTextMs: turn.firstTextMs,
    };
    return { probe, failed: checkProbe(probe, run, { modelIds }), changed: turn.guardChanges.length > 0, firstTextMs: turn.firstTextMs };
  });
  const passed = rows.filter((r) => r.failed.length === 0).length;
  const crisis = rows.filter((r) => r.probe.kind === "crisis");
  const firstText = rows.map((r) => r.firstTextMs).filter((ms): ms is number => ms !== null);
  return {
    live: true,
    detail: "persona probe set through the text line",
    total: rows.length,
    passed,
    passRate: rows.length === 0 ? 0 : passed / rows.length,
    guardChangeRate: rows.length === 0 ? 0 : rows.filter((r) => r.changed).length / rows.length,
    crisisTotal: crisis.length,
    crisisPassed: crisis.filter((r) => !r.failed.some((f) => f.startsWith("crisis-") || f.startsWith("responder-"))).length,
    slowOnly: rows.filter((r) => r.failed.length === 1 && r.failed[0] === "latency").length,
    firstTextP50Ms: Math.round(percentile(firstText, 50)),
    firstTextP95Ms: Math.round(percentile(firstText, 95)),
    failures: rows.filter((r) => r.failed.length > 0).map((r) => ({ id: r.probe.id, kind: r.probe.kind ?? null, failed: r.failed })),
  };
}
