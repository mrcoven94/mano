// Engine is the system of record: person memory, proposed actions and
// their hash-bound approvals all live there. The agent reaches it over
// Engine's person routes with a short-lived person session token it
// mints with Engine's SESSION_SECRET (ENGINE_SESSION_SECRET here), for
// the person behind the Channels handle. That handle reached the agent
// inside a turn Channels signed, so the mapping is only ever made from
// an authenticated handle.
const TOKEN_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

const boundFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface EngineConfig {
  baseUrl: string;
  sessionSecret: string;
  fetchFn?: typeof fetch;
}

export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig | null {
  if (!env.ENGINE_URL || !env.ENGINE_SESSION_SECRET) return null;
  return { baseUrl: env.ENGINE_URL.replace(/\/$/, ""), sessionSecret: env.ENGINE_SESSION_SECRET };
}

// One Engine person per Channels handle. Accounts (LAP-583) will link
// several handles to one person; until then the handle is the person.
export function personIdFor(handleHash: string): string {
  return `txt_${handleHash}`;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// Engine's session token format: v1.<base64url claims>.<base64url HMAC>.
export async function mintPersonToken(personId: string, secret: string, nowMs = Date.now()): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims = { kind: "person", sub: personId, org: null, iat, exp: iat + TOKEN_TTL_SECONDS };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${payload}`));
  return `v1.${payload}.${b64url(new Uint8Array(sig))}`;
}

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
  status: "completed" | "needs_approval" | "blocked" | "stale" | "reconciled" | "in_progress";
  approval?: EngineApproval;
  receipt?: { externalId: string; simulated: boolean };
  reason?: string;
}

// What the agent asks Engine to freeze for approval. Engine stamps the
// person from the token and owns hashing, policy and execution.
export interface ActionProposal {
  type: "submit" | "send" | "share";
  recipient: string;
  purpose: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

const RESULT_STATUSES = new Set(["completed", "needs_approval", "blocked", "stale", "reconciled", "in_progress"]);

function parseResult(value: unknown): EngineResult {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.status !== "string" || !RESULT_STATUSES.has(v.status)) throw new EngineError(502);
  return v as unknown as EngineResult;
}

export class EngineClient {
  private fetchFn: typeof fetch;
  constructor(private cfg: EngineConfig) {
    this.fetchFn = cfg.fetchFn ?? boundFetch;
  }

  private async call(personId: string, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await mintPersonToken(personId, this.cfg.sessionSecret);
    const res = await this.fetchFn(`${this.cfg.baseUrl}/api/persons/${encodeURIComponent(personId)}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res;
  }

  private async json(personId: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.call(personId, method, path, body);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new EngineError(res.status);
    }
    return res.json();
  }

  async listMemory(personId: string): Promise<MemoryRow[]> {
    const out = (await this.json(personId, "GET", "/memory")) as { memories?: unknown };
    const rows = Array.isArray(out.memories) ? out.memories : [];
    return rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => typeof r.id === "string" && typeof r.content === "string")
      .map((r) => ({ id: r.id as string, content: r.content as string }));
  }

  async addMemory(personId: string, content: string): Promise<string> {
    const out = (await this.json(personId, "POST", "/memory", { content, source: "agent" })) as { id?: unknown };
    if (typeof out.id !== "string") throw new EngineError(502);
    return out.id;
  }

  // Engine has no memory deletion route yet. The contract the agent
  // expects is DELETE /api/persons/:id/memory/:memoryId answering 2xx;
  // until Engine ships it, this reports "unsupported" and deletes nothing.
  async deleteMemory(personId: string, memoryId: string): Promise<"deleted" | "unsupported"> {
    const res = await this.call(personId, "DELETE", `/memory/${encodeURIComponent(memoryId)}`);
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return "deleted";
    if (res.status === 404 || res.status === 405) return "unsupported";
    throw new EngineError(res.status);
  }

  async proposeAction(personId: string, proposal: ActionProposal): Promise<EngineResult> {
    return parseResult(await this.json(personId, "POST", "/action", { ...proposal, actor: "foreground", origin: "person" }));
  }

  async approve(personId: string, approvalId: string): Promise<EngineResult> {
    return parseResult(await this.json(personId, "POST", `/approvals/${encodeURIComponent(approvalId)}/approve`));
  }
}

export function engineFromEnv(): EngineClient | null {
  const cfg = engineConfigFromEnv();
  return cfg ? new EngineClient(cfg) : null;
}
