import type { ActionRequest, CheckOutcome, Executor } from "./types.js";
import { DefiniteFailureError, TimeoutError } from "./types.js";
import { boundFetch } from "../fetch.js";

// In-memory stand-in: records calls, invents external IDs, and can fail
// once with a timeout for reconcile tests. Receipts are always labeled
// simulated so a drill never reads as real filing.
export class InMemoryExecutor implements Executor {
  readonly simulated = true;
  calls: ActionRequest[] = [];
  completed = new Map<string, { externalId: string }>();
  failNextWithTimeout = false;

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    if (this.completed.has(req.idempotencyKey)) {
      return this.completed.get(req.idempotencyKey)!;
    }
    this.calls.push(req);
    const externalId = `sim-${this.calls.length}`;
    this.completed.set(req.idempotencyKey, { externalId });
    if (this.failNextWithTimeout) {
      this.failNextWithTimeout = false;
      throw new TimeoutError();
    }
    return { externalId };
  }

  async check(idempotencyKey: string, _personId: string): Promise<CheckOutcome> {
    const found = this.completed.get(idempotencyKey);
    return found ? { found: true, externalId: found.externalId } : { found: false };
  }
}

// Executor against the sandbox agency portal (owned by the Spine session).
// Contract: POST {base}/v1/actions with the action JSON returns
// {externalId}; the portal dedupes on idempotencyKey, which is scoped as
// "<personId>:<key>". When the gateway verified a document, the post
// carries document: {hash, contentB64}. GET
// {base}/v1/actions/by-key/{key} returns {externalId} or 404. Receipts
// from this executor are real filings into the sandbox, never simulated.
export class SandboxExecutor implements Executor {
  readonly simulated = false;
  calls: ActionRequest[] = [];

  constructor(
    private baseUrl: string,
    private timeoutMs = 15000,
    private fetchFn: typeof fetch = boundFetch,
  ) {}

  private downstreamKey(req: ActionRequest): string {
    return `${req.personId}:${req.idempotencyKey}`;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    this.calls.push(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        idempotencyKey: this.downstreamKey(req),
        type: req.type,
        recipient: req.recipient,
        purpose: req.purpose,
        payload: req.payload,
      };
      if (req.document) body.document = { hash: req.document.hash, contentB64: req.document.bytesB64 };
      const res = await this.fetchFn(`${this.baseUrl}/v1/actions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      clearTimeout(timer);
      if (res.status === 429) throw new Error(`Sandbox portal is rate limited: ${res.status}`);
      if (res.status >= 400 && res.status < 500) {
        // The portal answered and refused: the action definitely did not
        // happen, so the gateway records a clean failed attempt.
        throw new DefiniteFailureError(`Sandbox portal rejected the action: ${res.status}`);
      }
      if (!res.ok) throw new Error(`Sandbox portal failed: ${res.status}`);
      const data = (await res.json()) as { externalId?: string };
      if (!data.externalId) throw new Error("Sandbox portal returned no external ID.");
      return { externalId: data.externalId };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError("Sandbox portal timed out.");
      }
      throw err;
    }
  }

  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(
        `${this.baseUrl}/v1/actions/by-key/${encodeURIComponent(`${personId}:${idempotencyKey}`)}`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      // Only the contract's explicit absent response means absent. A 200
      // without an external ID is malformed: the lookup is unavailable,
      // never "did not happen".
      if (res.status === 404) return { found: false };
      if (!res.ok) throw new Error(`Sandbox portal check failed: ${res.status}`);
      const data = (await res.json()) as { externalId?: string };
      if (typeof data.externalId === "string" && data.externalId) {
        return { found: true, externalId: data.externalId };
      }
      throw new Error("Sandbox portal check returned malformed data: HTTP 200 without an external ID.");
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError("Sandbox portal check timed out.");
      }
      throw err;
    }
  }
}

// Test seam: agents build their executor through createExecutor, and
// tests inject a shared controllable instance here to fail an execution
// on purpose through the real agent. Production code never sets it.
let testFactory: ((env: {
  EXECUTOR_MODE?: string;
  SANDBOX_BASE_URL?: string;
  MANO_ENV?: string;
}) => Executor) | null = null;

export function setExecutorFactoryForTests(
  factory: ((env: {
    EXECUTOR_MODE?: string;
    SANDBOX_BASE_URL?: string;
    MANO_ENV?: string;
  }) => Executor) | null,
): void {
  testFactory = factory;
}

// Picks the executor from config. Simulated must be an explicit choice:
// EXECUTOR_MODE=simulated set on purpose, or unset in development. Outside
// development with no choice made, construction fails loud instead of
// silently simulating.
export function createExecutor(env: {
  EXECUTOR_MODE?: string;
  SANDBOX_BASE_URL?: string;
  MANO_ENV?: string;
}): Executor {
  if (testFactory) return testFactory(env);
  const mode = env.EXECUTOR_MODE;
  if (mode === "simulated") return new InMemoryExecutor();
  if (mode === undefined && env.MANO_ENV === "development") return new InMemoryExecutor();
  if (mode === undefined) {
    throw new Error("Set EXECUTOR_MODE=simulated on purpose, or MANO_ENV=development for local stand-ins.");
  }
  if (mode === "sandbox") {
    if (!env.SANDBOX_BASE_URL) {
      throw new Error("EXECUTOR_MODE is sandbox but SANDBOX_BASE_URL is not set.");
    }
    return new SandboxExecutor(env.SANDBOX_BASE_URL.replace(/\/$/, ""));
  }
  throw new Error(`Unknown EXECUTOR_MODE: ${mode}.`);
}
