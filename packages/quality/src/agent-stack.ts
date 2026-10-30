// Starts Engine (wrangler dev) and Mano's agent (eve dev) on this machine for
// the agent path, with secrets made up for this run only: the agent secret,
// the handle grant secret, the agent's Engine token and Engine's own
// secrets. Production secrets never reach them, and they talk to nothing
// but each other and the model API. Engine runs in development mode, which
// keeps reminders and actions on its simulated executor.
//
// The stack owns its process trees. Each server starts as the leader of its
// own process group (wrangler starts workerd, eve starts workers), stop()
// sends SIGTERM to each whole group, waits a bounded grace period, then
// SIGKILLs whatever is left. SIGTERM or SIGINT to the bench stops the stack
// before the bench exits, so nothing keeps a CI job alive.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface AgentStack {
  agentUrl: string;
  agentSecret: string;
  grantSecret: string;
  stop(): Promise<void>;
}

export interface StackCommand {
  command: string;
  args: string[];
  cwd: string;
  // Path polled until the server answers.
  readyPath: string;
}

export interface StackOptions {
  ports?: { engine: number; agent: number };
  // Test seam: what to run instead of wrangler and eve.
  commands?: { engine: StackCommand; agent: StackCommand };
  startupMs?: number;
  graceMs?: number;
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

// SIGTERM to every group, then SIGKILL to any group still alive after the
// grace period. Resolves once every group is gone or has been killed.
async function stopGroups(procs: ChildProcess[], graceMs: number): Promise<void> {
  const pids = procs.map((p) => p.pid).filter((pid): pid is number => typeof pid === "number");
  for (const pid of pids) signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(groupAlive)) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(groupAlive)) signalGroup(pid, "SIGKILL");
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline && pids.some(groupAlive)) await new Promise((r) => setTimeout(r, 50));
}

// What happened to a child since spawn. The listeners go on at spawn time:
// a binary that cannot be launched emits 'error' instead of 'exit', and an
// 'error' with no listener would crash the whole bench.
interface Launched {
  proc: ChildProcess;
  ended: string | null;
}

function track(proc: ChildProcess): Launched {
  const launched: Launched = { proc, ended: null };
  proc.on("error", (err) => {
    launched.ended ??= `could not run (${(err as NodeJS.ErrnoException).code ?? err.name})`;
  });
  proc.on("exit", (code) => {
    launched.ended ??= `exited with code ${code ?? "none"}`;
  });
  return launched;
}

// Polls until the server answers. Each request is bounded by what is left of
// the startup budget, so a server that accepts and never replies cannot hold
// startup past it.
async function waitFor(url: string, launched: Launched, name: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (launched.ended !== null) throw new Error(`${name} ${launched.ended} before it was ready`);
    const left = deadline - Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, left))) });
      if (res.status < 500 || res.status === 503) return;
    } catch {
      // Not listening yet, or no answer within the bound.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`${name} was not ready within the startup budget`);
}

// META_MODEL_API_KEY comes from the caller's environment and goes only to
// the agent, which calls the model; Engine runs on its stand-in model.
export async function startAgentStack(env: NodeJS.ProcessEnv = process.env, opts: StackOptions = {}): Promise<AgentStack> {
  const ports = opts.ports ?? { engine: 8791, agent: 2091 };
  const graceMs = opts.graceMs ?? 10_000;
  const agentSecret = secret();
  const grantSecret = secret();
  const agentToken = secret();
  const dir = mkdtempSync(join(tmpdir(), "quality-agent-"));
  const engineEnv = join(dir, "engine.env");
  writeFileSync(
    engineEnv,
    [
      "MANO_ENV=development",
      `SESSION_SECRET=${secret()}`,
      `OPERATOR_SECRET=${secret()}`,
      `ENCRYPTION_KEK_B64=${randomBytes(32).toString("base64")}`,
      `MANO_ENGINE_AGENT_TOKEN=${agentToken}`,
      `MANO_HANDLE_GRANT_SECRET=${grantSecret}`,
      `MANO_ENGINE_CHANNELS_TOKEN=${secret()}`,
      `MANO_ENGINE_SEND_SECRET=${secret()}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  // The binaries themselves, not npx, so the group leader is the server.
  const commands = opts.commands ?? {
    engine: { command: join(REPO, "apps", "engine", "node_modules", ".bin", "wrangler"), args: ["dev", "--port", String(ports.engine), "--env-file", engineEnv], cwd: join(REPO, "apps", "engine"), readyPath: "/health" },
    agent: { command: join(REPO, "apps", "agent", "node_modules", ".bin", "eve"), args: ["dev", "--port", String(ports.agent), "--no-ui", "--logs", "error"], cwd: join(REPO, "apps", "agent"), readyPath: "/" },
  };
  const base = { PATH: env.PATH, HOME: env.HOME, CI: env.CI };
  const launch = (c: StackCommand, extra: Record<string, string | undefined>): Launched =>
    track(spawn(c.command, c.args, { cwd: c.cwd, env: { ...base, ...extra }, detached: true, stdio: ["ignore", "ignore", "inherit"] }));
  const engine = launch(commands.engine, { FAKE_PID_FILE: env.FAKE_PID_FILE });
  const agent = launch(commands.agent, {
    FAKE_PID_FILE: env.FAKE_PID_FILE,
    META_MODEL_API_KEY: env.META_MODEL_API_KEY,
    ...(env.MANO_MODEL_BASE_URL ? { MANO_MODEL_BASE_URL: env.MANO_MODEL_BASE_URL } : {}),
    MANO_AGENT_SECRET: agentSecret,
    ENGINE_URL: `http://127.0.0.1:${ports.engine}`,
    MANO_ENGINE_AGENT_TOKEN: agentToken,
  });

  let stopping: Promise<void> | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    void stop().finally(() => process.kill(process.pid, signal));
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      await stopGroups([engine.proc, agent.proc], graceMs);
      rmSync(dir, { recursive: true, force: true });
    })();
    return stopping;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    const deadline = Date.now() + (opts.startupMs ?? 180_000);
    await Promise.all([
      waitFor(`http://127.0.0.1:${ports.engine}${commands.engine.readyPath}`, engine, "Engine", deadline),
      waitFor(`http://127.0.0.1:${ports.agent}${commands.agent.readyPath}`, agent, "the agent", deadline),
    ]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { agentUrl: `http://127.0.0.1:${ports.agent}`, agentSecret, grantSecret, stop };
}
