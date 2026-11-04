// spine:live: Maria's whole renewal on a deployed Mano, from the first text to
// the portal's confirmation number, on a new synthetic handle each run. It
// spends model credit and files on the sandbox portal.
// Usage: pnpm spine:live [--runs N] [--lang en|es] [--yes <word>] [--past-fill] [--json]
// Needs MANO_AGENT_URL, MANO_ENGINE_URL, MANO_PORTAL_URL, MANO_AGENT_SECRET,
// MANO_HANDLE_GRANT_SECRET, MANO_ENGINE_CHANNELS_TOKEN, MANO_ENGINE_AGENT_TOKEN,
// SANDBOX_PORTAL_TOKEN, MANO_GUARDIAN_URL, MANO_GUARDIAN_TOKEN,
// MANO_GUARDIAN_KEY_ID and MANO_GUARDIAN_KEY_SECRET from the environment. It
// waits for the deployed Guardian to come up before the fill.
// --runs stops at the first failure. --json prints one object and nothing else.
// --past-fill carries on to YES after a draft with no computer fill behind it,
// to see the rest of the path; that run still fails.
// Exits 0 only when every run passed every step, 1 when a step failed, 2 on bad
// usage or missing settings.

import { parseArgs } from "node:util";
import { glimmerCheckerFromEnv } from "@mano/guardian";
import { REQUIRED_ENV, runLive, type Lang, type LiveConfig, type LiveRun, type StepReport } from "../spine-live.ts";

function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      runs: { type: "string", default: "1" },
      lang: { type: "string", default: "en" },
      yes: { type: "string" },
      "past-fill": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  }).values;
} catch (err) {
  usage(err instanceof Error ? err.message : "Bad arguments.");
}
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) usage("--runs takes a whole number of at least 1.");
if (args.lang !== "en" && args.lang !== "es") usage("--lang takes en or es.");
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) usage(`Missing from the environment: ${missing.join(", ")}`);

const env = (name: (typeof REQUIRED_ENV)[number]): string => process.env[name]!;
const guardian = glimmerCheckerFromEnv({
  MANO_GUARDIAN_URL: env("MANO_GUARDIAN_URL"),
  MANO_GUARDIAN_TOKEN: env("MANO_GUARDIAN_TOKEN"),
  MANO_GUARDIAN_KEY_ID: env("MANO_GUARDIAN_KEY_ID"),
  MANO_GUARDIAN_KEY_SECRET: env("MANO_GUARDIAN_KEY_SECRET"),
});
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const WHITESPACE_RUN = /\s+/g;

const print = (step: StepReport): void => {
  console.log(`  ${step.ok ? "pass" : "FAIL"}  ${step.step.padEnd(9)}${seconds(step.wallMs).padStart(9)}  ${step.model ?? "no model"}  ${step.detail}`);
  if (step.reply) console.log(`        Mano: ${step.reply.replace(WHITESPACE_RUN, " ")}`);
};

const config: LiveConfig = {
  agentUrl: env("MANO_AGENT_URL").replace(/\/$/, ""),
  engineUrl: env("MANO_ENGINE_URL").replace(/\/$/, ""),
  portalUrl: env("MANO_PORTAL_URL").replace(/\/$/, ""),
  agentSecret: env("MANO_AGENT_SECRET"),
  grantSecret: env("MANO_HANDLE_GRANT_SECRET"),
  engineChannelsToken: env("MANO_ENGINE_CHANNELS_TOKEN"),
  engineAgentToken: env("MANO_ENGINE_AGENT_TOKEN"),
  portalToken: env("SANDBOX_PORTAL_TOKEN"),
  lang: args.lang as Lang,
  ...(args.yes ? { yesWord: args.yes } : {}),
  ...(args["past-fill"] ? { pastFill: true } : {}),
  warmGuardian: () => guardian.warm!(),
  ...(args.json ? {} : { onStep: print }),
};

const results: LiveRun[] = [];
for (let n = 1; n <= runs; n++) {
  if (!args.json) console.log(`Run ${n} of ${runs}`);
  const run = await runLive(config);
  results.push(run);
  if (!args.json) {
    console.log(`  ${run.ok ? "passed" : `FAILED at ${run.failedStep}`} in ${seconds(run.wallMs)}, handle ${run.handle}, confirmation ${run.confirmation ?? "none"}`);
  }
  if (!run.ok) break;
}

const ok = results.length === runs && results.every((r) => r.ok);
if (args.json) console.log(JSON.stringify({ ok, runs: results }));
process.exitCode = ok ? 0 : 1;
