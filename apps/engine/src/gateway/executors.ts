import type { ActionRequest, Executor } from "./types.js";
import { TimeoutError } from "./types.js";

// In-memory stand-in: records calls, invents external IDs, and can fail
// once with a timeout for reconcile tests. Receipts are always labeled
// simulated so a drill never reads as a real filing.
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

  async check(idempotencyKey: string) {
    return this.completed.get(idempotencyKey) ?? null;
  }
}

// Executor against the sandbox agency portal (owned by the Spine session).
// Contract: POST {base}/v1/actions with the action JSON returns
// {externalId}; the portal dedupes on idempotencyKey. GET
// {base}/v1/actions/by-key/{key} returns {externalId} or 404. Receipts
// from this executor are real filings into the sandbox, never simulated.
export class SandboxExecutor implements Executor {
  readonly simulated = false;
  calls: ActionRequest[] = [];

  constructor(
    private baseUrl: string,
    private timeoutMs = 15000,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    this.calls.push(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/actions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: req.idempotencyKey,
          type: req.type,
          recipient: req.recipient,
          purpose: req.purpose,
          payload: req.payload,
        }),
      });
      clearTimeout(timer);
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

  async check(idempotencyKey: string): Promise<{ externalId: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(
        `${this.baseUrl}/v1/actions/by-key/${encodeURIComponent(idempotencyKey)}`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Sandbox portal check failed: ${res.status}`);
      const data = (await res.json()) as { externalId?: string };
      return data.externalId ? { externalId: data.externalId } : null;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError("Sandbox portal check timed out.");
      }
      throw err;
    }
  }
}

// Picks the executor from config. Unset means simulated (local default,
// always labeled). Sandbox mode requires the portal URL; anything else
// fails loud at construction instead of silently simulating.
export function createExecutor(env: { EXECUTOR_MODE?: string; SANDBOX_BASE_URL?: string }): Executor {
  const mode = env.EXECUTOR_MODE ?? "simulated";
  if (mode === "simulated") return new InMemoryExecutor();
  if (mode === "sandbox") {
    if (!env.SANDBOX_BASE_URL) {
      throw new Error("EXECUTOR_MODE is sandbox but SANDBOX_BASE_URL is not set.");
    }
    return new SandboxExecutor(env.SANDBOX_BASE_URL.replace(/\/$/, ""));
  }
  throw new Error(`Unknown EXECUTOR_MODE: ${mode}.`);
}
