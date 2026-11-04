// Every system under test and the loop that runs and grades one track. Used by
// the dev run (cli-baselines) and the held-out run (cli-heldout). Long model
// runs get a long harness timeout; the deterministic systems finish in seconds.
import { buildMano } from "./build-mano.mjs";
import { runSystem } from "./harness.mjs";
import { gradeAll, formatReport, formatPerScenario } from "./grader.mjs";

const here = (p) => new URL(p, import.meta.url).pathname;
const MODEL_RUN_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export const SYSTEMS = [
  { name: "Mano", build: buildMano, broker: true, live: true },
  { name: "plain reminder tool", entry: here("./systems/reminder.mjs"), broker: false, live: false },
  { name: "deterministic parser", entry: here("./systems/parser.mjs"), broker: false, live: false },
  { name: "general agent (one generic prompt)", entry: here("./systems/general-agent.mjs"), broker: true, live: true },
];

// Why each household ended the way it did, in the systems' fixed words. Reasons
// come from the eval's own code, never from a letter or a provider.
function statusCounts(outputs) {
  const counts = {};
  for (const o of outputs) counts[o.status] = (counts[o.status] ?? 0) + 1;
  return counts;
}

// Letters a model call could not answer. A high count means the provider
// failed, not that the system read badly, and the run should not be published.
const MODEL_FAILURES = new Set(["read_failed", "names_failed", "model_call_failed", "system_threw"]);
function modelFailures(outputs) {
  return outputs.reduce((n, o) => n + (o.failures ?? []).filter((f) => MODEL_FAILURES.has(f.reason)).length, 0);
}

// How Mano's answers treated each letter's expected date, for the report only.
// Nothing here reaches the grader. "Named right, not scored" means the answer
// showed the right date but the frozen mapping gave no credit, for example
// because it showed a second date too, so it does not change the score.
export function dateAnswerCounts(outputs, answers) {
  const counts = { letters: 0, held: 0, askedAndScored: 0, namedRightNotScored: 0, namedWrong: 0, noDate: 0 };
  for (const o of outputs) {
    for (const { letterId, dueDate } of answers[o.householdId]?.groundTruth?.deadlines ?? []) {
      const entry = o.letterDates?.find((d) => d.letterId === letterId);
      const held = entry?.held ?? [];
      const named = entry?.named ?? [];
      counts.letters++;
      if (held.includes(dueDate)) counts.held++;
      else if (o.reminders?.some((r) => r.letterId === letterId && r.dueDate === dueDate)) counts.askedAndScored++;
      else if (named.includes(dueDate)) counts.namedRightNotScored++;
      else if (held.length > 0 || named.length > 0) counts.namedWrong++;
      else counts.noDate++;
    }
  }
  return counts;
}

async function runOne(sys, inputs) {
  const built = sys.build ? await sys.build() : null;
  try {
    const t0 = Date.now();
    const { outputs } = await runSystem(built ? built.entry : sys.entry, inputs, {
      envAllow: [],
      broker: sys.broker,
      timeoutMs: MODEL_RUN_TIMEOUT_MS,
      ...(built ? { sandbox: built.sandbox } : {}),
    });
    return { outputs, wallMs: Date.now() - t0 };
  } finally {
    if (built) await built.cleanup();
  }
}

// Runs every system on a track and prints each report. perScenario adds cost
// and time per household (dev only: the held-out report stays aggregate).
export async function runTrack(trackName, inputs, answers, { label, perScenario = false, systems = SYSTEMS } = {}) {
  console.log(`# ${trackName} (${inputs.length} households)`);
  const results = {};
  for (const sys of systems) {
    const { outputs, wallMs } = await runOne(sys, inputs);
    const notRun = outputs.length > 0 && outputs.every((o) => o.status === "not run");
    if (notRun) {
      console.log(`## ${sys.name}`);
      console.log("status: not run (no model key)");
      console.log(`households: ${outputs.length}`);
      results[sys.name] = { notRun: true };
    } else {
      const graded = gradeAll(outputs, answers);
      const mode = sys.live ? label : "deterministic";
      console.log(formatReport(sys.name, graded, { costUsd: graded.costUsd, elapsedMs: wallMs, mode }));
      console.log(`household status: ${JSON.stringify(statusCounts(outputs))}`);
      if (outputs.some((o) => o.letterDates)) console.log(`date answers, not part of the score: ${JSON.stringify(dateAnswerCounts(outputs, answers))}`);
      if (sys.live) console.log(`model call failures: ${modelFailures(outputs)}`);
      console.log(`time per household: ${(graded.elapsedMs / Math.max(1, graded.households) / 1000).toFixed(2)}s`);
      results[sys.name] = graded;
    }
    if (perScenario) console.log(formatPerScenario(outputs));
    console.log("");
  }
  return results;
}
