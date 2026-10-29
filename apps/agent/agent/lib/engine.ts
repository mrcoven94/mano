// Engine is the system of record: person memory, proposed actions and
// their hash-bound approvals all live there. The agent calls Engine's
// person routes with its own service token (MANO_ENGINE_AGENT_TOKEN) plus
// the handle grant Channels signed for the turn. The grant names one
// handle and expires within minutes, so the agent can act only for the
// person who just texted; it never holds the secret that signs grants.
import { personIdForHandle } from "@mano/protocol";

const REQUEST_TIMEOUT_MS = 15_000;
export const HANDLE_GRANT_HEADER = "x-mano-handle-grant";

const boundFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface EngineConfig {
  baseUrl: string;
  agentToken: string;
  fetchFn?: typeof fetch;
}

export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig | null {
  if (!env.ENGINE_URL || !env.MANO_ENGINE_AGENT_TOKEN) return null;
  return { baseUrl: env.ENGINE_URL.replace(/\/$/, ""), agentToken: env.MANO_ENGINE_AGENT_TOKEN };
}

// The Engine person a Channels handle maps to (Engine accepts a grant
// only on this person's routes).
export const personIdFor = personIdForHandle;

export class EngineError extends Error {
  constructor(readonly status: number) {
    super(`Engine answered ${status}.`);
    this.name = "EngineError";
  }
}

export interface MemoryRow {
  id: string;
  content: string;
}

export interface EngineApproval {
  id: string;
  status: string;
  recipient: string;
  purpose: string;
  requestJson: string;
  requestHash: string;
  expiresAt: string;
}

export interface EngineResult {
  status: "completed" | "needs_approval" | "blocked" | "stale" | "reconciled" | "in_progress" | "rejected";
  approval?: EngineApproval;
  receipt?: { externalId: string; simulated: boolean };
  reason?: string;
}

// What the agent asks Engine to freeze for approval. Engine stamps the
// person from the grant and owns hashing, policy and execution.
export interface ActionProposal {
  type: "submit" | "send" | "share";
  recipient: string;
  purpose: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

const RESULT_STATUSES = new Set(["completed", "needs_approval", "blocked", "stale", "reconciled", "in_progress", "rejected"]);

function parseResult(value: unknown): EngineResult {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.status !== "string" || !RESULT_STATUSES.has(v.status)) throw new EngineError(502);
  return v as unknown as EngineResult;
}

// Engine's routes for one person, reached with the turn's handle grant.
export class PersonEngine {
  readonly personId: string;
  private fetchFn: typeof fetch;

  constructor(
    private cfg: EngineConfig,
    handleHash: string,
    private grant: string,
  ) {
    this.personId = personIdFor(handleHash);
    this.fetchFn = cfg.fetchFn ?? boundFetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchFn(`${this.cfg.baseUrl}/api/persons/${encodeURIComponent(this.personId)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.agentToken}`,
        [HANDLE_GRANT_HEADER]: this.grant,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.call(method, path, body);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new EngineError(res.status);
    }
    return res.json();
  }

  async listMemory(): Promise<MemoryRow[]> {
    const out = (await this.json("GET", "/memory")) as { memories?: unknown };
    const rows = Array.isArray(out.memories) ? out.memories : [];
    return rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => typeof r.id === "string" && typeof r.content === "string")
      .map((r) => ({ id: r.id as string, content: r.content as string }));
  }

  async addMemory(content: string): Promise<string> {
    const out = (await this.json("POST", "/memory", { content, source: "agent" })) as { id?: unknown };
    if (typeof out.id !== "string") throw new EngineError(502);
    return out.id;
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.json("DELETE", `/memory/${encodeURIComponent(memoryId)}`);
  }

  async proposeAction(proposal: ActionProposal): Promise<EngineResult> {
    return parseResult(await this.json("POST", "/action", { ...proposal, actor: "foreground", origin: "person" }));
  }

  async approve(approvalId: string): Promise<EngineResult> {
    return parseResult(await this.json("POST", `/approvals/${encodeURIComponent(approvalId)}/approve`));
  }

  // The approval's own status, or null when Engine has no such approval.
  // "approved" means it was consumed: execution started, whatever the
  // last answer said.
  async approvalStatus(approvalId: string): Promise<string | null> {
    const out = (await this.json("GET", "/approvals")) as { approvals?: unknown };
    const rows = Array.isArray(out.approvals) ? (out.approvals as Record<string, unknown>[]) : [];
    const row = rows.find((r) => r.id === approvalId);
    return typeof row?.status === "string" ? row.status : null;
  }

  async reject(approvalId: string): Promise<EngineResult> {
    return parseResult(await this.json("POST", `/approvals/${encodeURIComponent(approvalId)}/reject`));
  }
}

export interface Engine {
  forHandle(handleHash: string, grant: string): PersonEngine;
}

export function engineFrom(cfg: EngineConfig | null): Engine | null {
  return cfg ? { forHandle: (handleHash, grant) => new PersonEngine(cfg, handleHash, grant) } : null;
}

export function engineFromEnv(): Engine | null {
  return engineFrom(engineConfigFromEnv());
}
