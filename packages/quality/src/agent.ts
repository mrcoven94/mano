// Mano's agent as an answer path. Live texts go through the agent when the
// text line has AGENT_URL set: Channels' AgentResponder signs the turn, the
// agent (apps/agent) runs it against Engine, and on a timeout or failure
// AgentResponder falls back to the plain model answer. This path drives that
// same AgentResponder, with the plain answer as its fallback, then the same
// send pipeline as the text line (textline.ts). Every case gets a fresh
// synthetic handle, so no case sees another's memory or reminders.
//
// The agent and Engine run locally (agent-stack.ts starts both with
// throwaway secrets); nothing here talks to the production agent. Each
// answer says whether the agent answered or the fallback did.

import { randomBytes } from "node:crypto";
import { AgentResponder } from "@mano/channels";
import type { AnswerPath, BenchAnswer } from "./paths.ts";
import type { BenchCase } from "./suites/types.ts";
import { TextLine, TextLinePath, crisisCheckModelFromEnv, sparkResponder, type TextLineOptions } from "./textline.ts";

export interface AgentPathOptions extends TextLineOptions {
  agentUrl: string;
  agentSecret: string;
  grantSecret: string;
  retryDelayMs?: number;
}

export class AgentPath implements AnswerPath {
  readonly name = "agent";
  readonly live = true;
  readonly knowsCatalog = false;
  private opts: AgentPathOptions;

  constructor(opts: AgentPathOptions) {
    this.opts = opts;
  }

  // A new synthetic person per case: a random handle hash never tied to a
  // phone number, as the agent's own live evals do.
  private lineForCase(): TextLine {
    const responder = new AgentResponder({
      agentUrl: this.opts.agentUrl,
      secret: this.opts.agentSecret,
      grantSecret: this.opts.grantSecret,
      handleHash: randomBytes(32).toString("hex"),
      fallback: sparkResponder(this.opts),
      ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
    });
    return new TextLine({ ...this.opts, responder });
  }

  async answer(c: BenchCase): Promise<BenchAnswer> {
    return new TextLinePath(this.lineForCase(), this.opts.retryDelayMs).answer(c);
  }
}

// QUALITY_AGENT_URL points at a running agent; MANO_AGENT_SECRET and
// MANO_HANDLE_GRANT_SECRET are the ones that agent and its Engine use.
export function agentPathFromEnv(env: NodeJS.ProcessEnv = process.env): AgentPath | null {
  const agentUrl = env.QUALITY_AGENT_URL ?? "";
  const agentSecret = env.MANO_AGENT_SECRET ?? "";
  const grantSecret = env.MANO_HANDLE_GRANT_SECRET ?? "";
  const apiKey = env.META_MODEL_API_KEY ?? "";
  const model = env.MANO_MODEL_BENCH_ID ?? "";
  if (!agentUrl || !agentSecret || !grantSecret || !apiKey || !model) return null;
  return new AgentPath({
    agentUrl,
    agentSecret,
    grantSecret,
    apiKey,
    model,
    crisisCheckModel: crisisCheckModelFromEnv(env),
    ...(env.MANO_MODEL_BASE_URL ? { baseUrl: env.MANO_MODEL_BASE_URL } : {}),
  });
}
