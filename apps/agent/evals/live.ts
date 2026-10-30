// Shared harness for live voice evals. They text the agent the way
// Channels does: a signed turn on the Mano channel route, with a turn ID,
// the deletion generation and a handle grant, for a fresh synthetic
// handle per eval, so every tool runs with the attributes it gets in
// production. They need the real model, a running Engine (locally,
// pnpm --filter @mano/engine dev), the agent secret, and the handle grant
// secret, which only the eval holds, to play Channels. Without any of
// those the eval skips instead of failing. Messages are synthetic only,
// per AGENTS.md hard rule 2.
import { randomBytes, randomUUID } from "node:crypto";

import { mintHandleGrant } from "@mano/protocol";

import { signBody, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../agent/lib/auth.js";
import { engineFromEnv, type PersonEngine } from "../agent/lib/engine.js";

const NEEDED = ["META_MODEL_API_KEY", "MANO_AGENT_SECRET", "ENGINE_URL", "MANO_ENGINE_AGENT_TOKEN", "MANO_HANDLE_GRANT_SECRET"];

interface EvalLike {
  skip: (reason: string) => void;
  target: { fetch: (path: string, init?: RequestInit) => Promise<Response> };
}

export function requireLiveVoice(t: { skip: (reason: string) => void }): boolean {
  const missing = NEEDED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    t.skip(`needs ${missing.join(", ")}`);
    return false;
  }
  return true;
}

export interface Person {
  handleHash: string;
  text(message: string): Promise<{ status: number; state: string; message: string }>;
  engine(): Promise<PersonEngine>;
}

// One synthetic person texting the agent.
export function syntheticPerson(t: EvalLike): Person {
  const handleHash = randomBytes(32).toString("hex");
  const grant = () => mintHandleGrant(handleHash, process.env.MANO_HANDLE_GRANT_SECRET!);
  return {
    handleHash,
    async text(message: string) {
      const raw = JSON.stringify({
        turnId: `eval-${randomUUID()}`,
        generation: 0,
        receivedAt: Date.now(),
        handleHash,
        grant: await grant(),
        texts: [message],
        attachmentCount: 0,
      });
      const ts = Math.floor(Date.now() / 1000);
      const res = await t.target.fetch("/channels/mano/turn", {
        method: "POST",
        headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(process.env.MANO_AGENT_SECRET!, ts, raw) },
        body: raw,
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; text?: string };
      return { status: res.status, state: body.status ?? "", message: body.text ?? "" };
    },
    async engine() {
      return engineFromEnv()!.forHandle(handleHash, await grant(), 0);
    },
  };
}

export function answered(reply: { status: number }): boolean {
  return reply.status === 200;
}

export function shortReply(maxChars: number): (message: string) => boolean {
  return (message: string) => message.length > 0 && message.length <= maxChars;
}

export function hasNoUrl(message: string): boolean {
  return !/https?:\/\/|www\./i.test(message);
}

export function namesNoModel(message: string): boolean {
  return !/muse|spark|wonder|meta|anthropic|openai|gpt|claude|llama/i.test(message);
}

export function questionCount(message: string): number {
  return (message.match(/\?/g) ?? []).length;
}
