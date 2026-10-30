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
  idempotencyKey: string;
  requestJson: string;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
  // What became of a consumed approval: the attempt's state and, once it
  // settled, its receipt. Requested from Engine (see the PR 60 comment);
  // absent means unknown, and the agent then never claims an outcome.
  outcome?: {
    attempt: "in_flight" | "unknown" | "failed" | "done" | null;
    receipt: { externalId: string; simulated: boolean } | null;
  };
}

// Engine's per-person agent state (reminders, turn ledger, approval
// pointer), shapes as Engine's agent-state routes return them.
export type ReminderStatus = "scheduled" | "sending" | "sent" | "dropped" | "failed" | "cancelled";

export interface EngineReminder {
  id: string;
  text: string;
  dueAt: string;
  generation: number;
  status: ReminderStatus;
  attempts: number;
}

export interface EngineTurn {
  turnId: string;
  firstReceivedAt: string;
  status: "open" | "complete";
  completedAt: string | null;
}

export interface EnginePointer {
  approvalId: string;
  generation: number;
  setAt: string;
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

  // generation: the Channels deletion generation this turn runs under.
  // Every write carries it and Engine re-checks it at the write, so
  // nothing prepared before a deletion lands after it.
  constructor(
    private cfg: EngineConfig,
    handleHash: string,
    private grant: string,
    readonly generation: number,
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

  async listApprovals(): Promise<EngineApproval[]> {
    const out = (await this.json("GET", "/approvals")) as { approvals?: unknown };
    return Array.isArray(out.approvals) ? (out.approvals as EngineApproval[]) : [];
  }

  // Creates the reminder, or returns the one this ID already names. A
  // conflict (same ID, different stored content) also returns the stored
  // reminder: the ID is derived from the turn, the due time and the
  // wording, so it is the same reminder said differently.
  async createReminder(input: { id: string; text: string; dueAt: string }): Promise<EngineReminder> {
    const res = await this.call("POST", "/reminders", { ...input, generation: this.generation });
    const body = (await res.json().catch(() => null)) as { reminder?: EngineReminder } | null;
    // A 409 without a reminder is the generation fence: the conversation
    // was deleted after this turn began.
    if ((res.ok || res.status === 409) && body?.reminder) return body.reminder;
    throw new EngineError(res.status);
  }

  async listReminders(): Promise<EngineReminder[]> {
    const out = (await this.json("GET", "/reminders")) as { reminders?: unknown };
    return Array.isArray(out.reminders) ? (out.reminders as EngineReminder[]) : [];
  }

  // null when Engine has no such reminder for this person.
  async cancelReminder(id: string): Promise<{ reminder: EngineReminder; cancelled: boolean } | null> {
    const res = await this.call("POST", `/reminders/${encodeURIComponent(id)}/cancel`);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new EngineError(res.status);
    }
    return (await res.json()) as { reminder: EngineReminder; cancelled: boolean };
  }

  // The turn as Engine first recorded it: firstReceivedAt never changes.
  async putTurn(turnId: string, receivedAt: string): Promise<EngineTurn> {
    const out = (await this.json("POST", "/turns", { turnId, receivedAt, generation: this.generation })) as { turn: EngineTurn };
    return out.turn;
  }

  async completeTurn(turnId: string): Promise<void> {
    await this.json("POST", `/turns/${encodeURIComponent(turnId)}/complete`, { generation: this.generation });
  }

  async getPointer(): Promise<EnginePointer | null> {
    const out = (await this.json("GET", `/pending-approval?generation=${this.generation}`)) as { pointer?: EnginePointer | null };
    return out.pointer ?? null;
  }

  // null when Engine refused: the approval is not this person's, or not of
  // the current generation.
  async setPointer(approvalId: string): Promise<EnginePointer | null> {
    const res = await this.call("PUT", "/pending-approval", { approvalId, generation: this.generation });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new EngineError(res.status);
    }
    return ((await res.json()) as { pointer: EnginePointer }).pointer;
  }

  // Compare-and-delete: clears only while the pointer still names this
  // approval under this generation.
  async clearPointer(approvalId: string): Promise<void> {
    await this.json("DELETE", "/pending-approval", { approvalId, generation: this.generation });
  }

  async getConversationGeneration(): Promise<number> {
    const out = (await this.json("GET", "/conversation")) as { generation?: unknown };
    if (typeof out.generation !== "number") throw new EngineError(502);
    return out.generation;
  }

  // Moves Engine to this turn's generation when Channels deleted the
  // conversation but its own call to Engine never landed. A transition:
  // at or past it, Engine changes nothing.
  async advanceConversation(): Promise<void> {
    await this.json("DELETE", "/conversation", { generation: this.generation });
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
    const out = (await this.json("POST", "/memory", { content, source: "agent", generation: this.generation })) as { id?: unknown };
    if (typeof out.id !== "string") throw new EngineError(502);
    return out.id;
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.json("DELETE", `/memory/${encodeURIComponent(memoryId)}`);
  }

  async proposeAction(proposal: ActionProposal): Promise<EngineResult> {
    return parseResult(
      await this.json("POST", "/action", { ...proposal, actor: "foreground", origin: "person", generation: this.generation }),
    );
  }

  async approve(approvalId: string): Promise<EngineResult> {
    return parseResult(await this.json("POST", `/approvals/${encodeURIComponent(approvalId)}/approve`));
  }

  // One approval of this person, or null. Status "approved" means it was
  // consumed: execution started, whatever the last answer said.
  async approval(approvalId: string): Promise<EngineApproval | null> {
    return (await this.listApprovals()).find((a) => a.id === approvalId) ?? null;
  }

  async reject(approvalId: string): Promise<EngineResult> {
    return parseResult(await this.json("POST", `/approvals/${encodeURIComponent(approvalId)}/reject`));
  }
}

export interface Engine {
  forHandle(handleHash: string, grant: string, generation: number): PersonEngine;
}

export function engineFrom(cfg: EngineConfig | null): Engine | null {
  return cfg ? { forHandle: (handleHash, grant, generation) => new PersonEngine(cfg, handleHash, grant, generation) } : null;
}

export function engineFromEnv(): Engine | null {
  return engineFrom(engineConfigFromEnv());
}
