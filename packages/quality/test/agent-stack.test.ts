// Review of PR 73, items 1 and 6: the stack owns its whole process trees,
// stops them on shutdown and on SIGTERM or SIGINT, kills survivors after a
// bounded grace period, and never waits on a readiness request longer than
// the startup budget allows.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startAgentStack, type StackCommand } from "../src/agent-stack.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-server.mjs");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fake(port: number, extra: string[] = []): StackCommand {
  return { command: process.execPath, args: [FAKE, "--port", String(port), ...extra], cwd: tmpdir(), readyPath: "/" };
}

test("stop ends both servers and the processes they spawned", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "stack-")), "pids");
  const stack = await startAgentStack(
    { PATH: process.env.PATH, FAKE_PID_FILE: pidFile },
    { ports: { engine: 18791, agent: 18792 }, commands: { engine: fake(18791), agent: fake(18792) }, graceMs: 500 },
  );
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 4, "two servers and two grandchildren");
  assert.ok(pids.every(alive));
  await stack.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(pids.filter(alive), [], "a process outlived stop()");
});

test("a server that never answers fails startup within the budget and is killed", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "stack-")), "pids");
  const started = Date.now();
  await assert.rejects(
    startAgentStack(
      { PATH: process.env.PATH, FAKE_PID_FILE: pidFile },
      { ports: { engine: 18793, agent: 18794 }, commands: { engine: fake(18793, ["--hang"]), agent: fake(18794) }, startupMs: 3000, graceMs: 500 },
    ),
    /not ready/,
  );
  assert.ok(Date.now() - started < 8000, `startup took ${Date.now() - started} ms against a 3 s budget`);
  await new Promise((r) => setTimeout(r, 300));
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  assert.deepEqual(pids.filter(alive), [], "a hung server survived a failed startup");
});

test("SIGTERM to the bench stops the stack before it exits", async () => {
  const { spawn } = await import("node:child_process");
  const pidFile = join(mkdtempSync(join(tmpdir(), "stack-")), "pids");
  const script = `
    const { startAgentStack } = await import(${JSON.stringify(join(dirname(FAKE), "..", "..", "src", "agent-stack.ts"))});
    const fake = (port) => ({ command: process.execPath, args: [${JSON.stringify(FAKE)}, "--port", String(port)], cwd: ${JSON.stringify(tmpdir())}, readyPath: "/" });
    await startAgentStack({ PATH: process.env.PATH, FAKE_PID_FILE: ${JSON.stringify(pidFile)} }, { ports: { engine: 18795, agent: 18796 }, commands: { engine: fake(18795), agent: fake(18796) }, graceMs: 500 });
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const bench = spawn(process.execPath, ["--import", join(dirname(FAKE), "..", "..", "src", "register.ts"), "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => bench.stdout!.on("data", (d) => String(d).includes("ready") && resolve()));
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  bench.kill("SIGTERM");
  await new Promise((r) => bench.once("exit", r));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pids.filter(alive), [], "SIGTERM left processes running");
});

// Sol, round 2 at 5d60f0e: a binary that cannot be launched emits 'error'
// on its child process. It must fail startup through the awaited cleanup,
// kill the sibling, and leave the nightly running with a fixed reason.
test("a missing agent binary fails the stage cleanly and kills Engine", async () => {
  const { runAgentStageSafely } = await import("../src/agent-stage.ts");
  const pidFile = join(mkdtempSync(join(tmpdir(), "stack-")), "pids");
  const missing: StackCommand = { command: join(tmpdir(), "no-such-binary-for-quality"), args: [], cwd: tmpdir(), readyPath: "/" };
  const out = await runAgentStageSafely({ PATH: process.env.PATH }, {
    start: (env) => startAgentStack({ ...env, FAKE_PID_FILE: pidFile }, { ports: { engine: 18797, agent: 18798 }, commands: { engine: fake(18797), agent: missing }, graceMs: 500, startupMs: 20_000 }),
  });
  assert.equal(out.summary.ran, false);
  assert.equal(out.summary.detail, "the agent stage could not start Engine and the agent");
  await new Promise((r) => setTimeout(r, 300));
  const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
  assert.deepEqual(pids.filter(alive), [], "the Engine stand-in outlived a failed start");
});
