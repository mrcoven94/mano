// Subprocess harness: the system under test runs as a separate node process
// that receives only input JSON (and image paths on the photo track). It
// gets a scrubbed environment, a temp-dir cwd outside the repo, and argv
// pointing only at its input and output files: no answers file, no
// generator handle, no held-out seed. Only allow-listed keys pass through
// (META_MODEL_API_KEY for the general agent).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withRunDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-run-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function scrubbedEnv(allow) {
  const env = { PATH: process.env.PATH || "/usr/bin:/bin" };
  for (const k of allow) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

// Run one system entry (node script taking --input <json> --out <json>)
// over all inputs. Returns { outputs, runs } where runs records per-system
// process facts for the report.
export async function runSystem(entryFile, inputs, { envAllow = [], timeoutMs = 1500000 } = {}) {
  return withRunDir(async (dir) => {
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    await writeFile(inputPath, JSON.stringify(inputs));
    const child = spawn(process.execPath, [entryFile, "--input", inputPath, "--out", outputPath], {
      cwd: dir,
      env: scrubbedEnv(envAllow),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: "timeout", signal: "SIGKILL" });
      }, timeoutMs);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: "spawn_error", signal: null });
      });
    });
    if (exit.code !== 0) {
      return {
        outputs: inputs.map((h) => ({
          householdId: h.householdId,
          baseline: "unknown",
          status: "error",
          reason: `system process failed: ${exit.code}`,
          reminders: [],
          packet: [],
          refused: [],
          enforced: [],
          requested: [],
          failures: [{ letterId: "*", reason: "system_crashed" }],
          toolCalls: [],
          costUsd: 0,
          elapsedMs: 0,
          stderr: stderr.slice(0, 1000),
        })),
        runs: { exit, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
      };
    }
    const outputs = JSON.parse(await readFile(outputPath, "utf8"));
    return { outputs, runs: { exit } };
  });
}
