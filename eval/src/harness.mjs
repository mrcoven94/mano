// Subprocess harness: the system under test runs as a separate node process
// that receives only input JSON (and staged image copies on the photo
// track). The system code is copied into the run dir and the child runs
// under Node's permission model: it may read only the run dir and the
// system temp dir, and write only the run dir. Answers, the generator,
// and the seed are never visible: the environment is scrubbed to PATH
// plus allow-listed keys, argv names only the run dir files, and held-out
// answers are never written to disk while a system runs.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

export async function withRunDir(fn) {
  // Resolved: the permission model checks literal path components, so any
  // symlink (like /tmp on macOS) would demand its ancestors too.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-run-")));
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
// over all inputs. netAllow lists the only hosts the child may reach
// (the permission model denies network by default). Returns { outputs, runs }.
export async function runSystem(entryFile, inputs, { envAllow = [], netAllow = [], timeoutMs = 1500000 } = {}) {
  return withRunDir(async (dir) => {
    // Stage the system code, inputs, and photo copies inside the run dir.
    const sysDir = join(dir, "sys", "systems");
    await mkdir(sysDir, { recursive: true });
    const stagedEntry = join(sysDir, basename(entryFile));
    await copyFile(entryFile, stagedEntry);
    const srcDir = dirname(dirname(entryFile));
    for (const f of ["baselines.mjs", "tools.mjs"]) {
      try {
        await copyFile(join(srcDir, f), join(dir, "sys", f));
      } catch { /* probe entries travel without the package */ }
    }
    const assetsDir = join(dir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const stagedInputs = [];
    for (const h of inputs) {
      const letters = [];
      for (const l of h.letters || []) {
        if (!l.photos) {
          letters.push(l);
          continue;
        }
        const staged = [];
        for (const p of l.photos) {
          const dest = join(assetsDir, basename(p));
          await copyFile(p, dest);
          staged.push(dest);
        }
        letters.push({ ...l, photos: staged });
      }
      stagedInputs.push({ ...h, letters });
    }
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    await writeFile(inputPath, JSON.stringify(stagedInputs));
    const realTmp = await realpath(tmpdir());
    const child = spawn(
      process.execPath,
      [
        // One value per flag: comma-joined values are treated as one path.
        "--permission",
        `--allow-fs-read=${realTmp}`,
        `--allow-fs-read=${dir}`,
        `--allow-fs-write=${dir}`,
        ...netAllow.map((h) => `--allow-net=${h}`),
        stagedEntry,
        "--input", inputPath,
        "--out", outputPath,
      ],
      { cwd: dir, env: scrubbedEnv(envAllow), stdio: ["ignore", "pipe", "pipe"] }
    );
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
          costUsd: null,
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
