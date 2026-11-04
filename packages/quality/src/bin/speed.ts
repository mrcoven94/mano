// speed: measure reply latency and health against a running agent, with signed
// synthetic turns only, and write the numbers to a folder. Never a resident.
// Usage: node --import ./src/register.ts src/bin/speed.ts [--rounds 20]
// [--gap-ms 20000] [--health https://host/health]... [--out runs/speed]
// Needs QUALITY_AGENT_URL, MANO_AGENT_SECRET and MANO_HANDLE_GRANT_SECRET.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPEED_TURNS, healthStats, runSpeed, turnStats } from "../speed.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const agentUrl = process.env.QUALITY_AGENT_URL ?? "";
const agentSecret = process.env.MANO_AGENT_SECRET ?? "";
const grantSecret = process.env.MANO_HANDLE_GRANT_SECRET ?? "";
if (!agentUrl || !agentSecret || !grantSecret) {
  console.error("speed needs QUALITY_AGENT_URL, MANO_AGENT_SECRET and MANO_HANDLE_GRANT_SECRET");
  process.exit(2);
}

const healthUrls = process.argv.flatMap((value, i) => (process.argv[i - 1] === "--health" ? [value] : []));
const out = arg("--out") ?? "runs/speed";
const startedAt = new Date().toISOString();
const { turns, health } = await runSpeed({
  agentUrl,
  agentSecret,
  grantSecret,
  rounds: Number(arg("--rounds") ?? 20),
  gapMs: Number(arg("--gap-ms") ?? 20_000),
  healthUrls,
  healthEveryMs: 30_000,
  onTurn: (t) => console.log(`round ${t.round} ${t.kind}: ${t.ms} ms${t.answered ? "" : " (no answer)"}`),
});
const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  turns: Object.fromEntries(SPEED_TURNS.map((t) => [t.kind, turnStats(turns, t.kind)])),
  health: healthUrls.map((url) => healthStats(health, url)),
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "speed.json"), `${JSON.stringify({ ...summary, samples: turns, healthSamples: health }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (turns.some((t) => !t.answered)) process.exitCode = 1;
