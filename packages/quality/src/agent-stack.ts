// Starts Engine (wrangler dev) and Mano's agent (eve dev) on this machine for
// the agent path, with secrets made up for this run only: the agent secret,
// the handle grant secret, the agent's Engine token and Engine's own
// secrets. Production secrets never reach them, and they talk to nothing
// but each other and the model API. Engine runs in development mode, which
// keeps reminders and actions on its simulated executor.

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
  stop(): void;
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

async function waitFor(url: string, proc: ChildProcess, name: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let exited: number | null = null;
  proc.once("exit", (code) => {
    exited = code ?? -1;
  });
  while (Date.now() - started < timeoutMs) {
    if (exited !== null) throw new Error(`${name} exited with code ${exited} before it was ready`);
    try {
      const res = await fetch(url);
      if (res.status < 500 || res.status === 503) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${name} was not ready after ${Math.round(timeoutMs / 1000)} s`);
}

// META_MODEL_API_KEY comes from the caller's environment and goes only to
// the agent, which calls the model; Engine runs on its stand-in model.
export async function startAgentStack(env: NodeJS.ProcessEnv = process.env, ports = { engine: 8791, agent: 2091 }): Promise<AgentStack> {
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
  const quiet = { stdio: ["ignore", "ignore", "inherit"] as ["ignore", "ignore", "inherit"] };
  const engine = spawn("npx", ["wrangler", "dev", "--port", String(ports.engine), "--env-file", engineEnv], {
    cwd: join(REPO, "apps", "engine"),
    env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI },
    ...quiet,
  });
  const agent = spawn("npx", ["eve", "dev", "--port", String(ports.agent), "--no-ui", "--logs", "error"], {
    cwd: join(REPO, "apps", "agent"),
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      CI: env.CI,
      META_MODEL_API_KEY: env.META_MODEL_API_KEY,
      ...(env.MANO_MODEL_BASE_URL ? { MANO_MODEL_BASE_URL: env.MANO_MODEL_BASE_URL } : {}),
      MANO_AGENT_SECRET: agentSecret,
      ENGINE_URL: `http://127.0.0.1:${ports.engine}`,
      MANO_ENGINE_AGENT_TOKEN: agentToken,
    },
    ...quiet,
  });
  const stop = (): void => {
    engine.kill("SIGTERM");
    agent.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitFor(`http://127.0.0.1:${ports.engine}/health`, engine, "Engine", 120_000);
    await waitFor(`http://127.0.0.1:${ports.agent}/`, agent, "the agent", 120_000);
  } catch (err) {
    stop();
    throw err;
  }
  return { agentUrl: `http://127.0.0.1:${ports.agent}`, agentSecret, grantSecret, stop };
}
