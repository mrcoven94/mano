import type { ActionRequest, CheckOutcome, Executor } from "./types.js";
import { DefiniteFailureError, TimeoutError } from "./types.js";
import { boundFetch } from "../fetch.js";
import { base64ToBytes, sha256Hex } from "../hash.js";

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

// Executor against the sandbox agency portal (apps/sandbox-portal), over
// its JSON API with the portal's bearer token. POST {base}/submissions
// with { key, household, files } answers { confirmationNumber }, which
// becomes the receipt's external ID. GET {base}/submissions/{key} answers
// it again, or 404 when the key never filed. The portal dedupes on the
// key, which is the SHA-256 of "<personId>:<idempotencyKey>" so it is
// scoped to the person and fits the portal's 128-character limit. When
// the gateway verified a document, its bytes go as the one attachment.
// Receipts from this executor are real filings into the sandbox, never
// simulated.
const HOUSEHOLD_FIELDS = ["fullName", "dateOfBirth", "address", "phone", "householdSize", "monthlyIncome"] as const;

function documentType(bytes: Uint8Array): { type: string; ext: string } | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { type: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return { type: "application/pdf", ext: "pdf" };
  return null;
}

export class SandboxExecutor implements Executor {
  readonly simulated = false;
  calls: ActionRequest[] = [];

  constructor(
    private baseUrl: string,
    private timeoutMs = 15000,
    private fetchFn: typeof fetch = boundFetch,
    private token?: string,
  ) {}

  private async downstreamKey(personId: string, idempotencyKey: string): Promise<string> {
    return `mano-${await sha256Hex(`${personId}:${idempotencyKey}`)}`;
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    this.calls.push(req);
    const household: Record<string, string> = {};
    for (const field of HOUSEHOLD_FIELDS) {
      const value = req.payload[field];
      if (typeof value === "string" || typeof value === "number") household[field] = String(value);
    }
    const body: Record<string, unknown> = { key: await this.downstreamKey(req.personId, req.idempotencyKey), household };
    if (req.document) {
      const kind = documentType(base64ToBytes(req.document.bytesB64));
      if (!kind) throw new DefiniteFailureError("The portal takes PDF, PNG or JPG documents only.");
      body.files = [{ name: `document-1.${kind.ext}`, type: kind.type, data: req.document.bytesB64 }];
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/submissions`, {
        method: "POST",
        signal: controller.signal,
        headers: this.headers(true),
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
      const data = (await res.json()) as { confirmationNumber?: unknown };
      if (typeof data.confirmationNumber !== "string" || !data.confirmationNumber) {
        throw new Error("Sandbox portal returned no confirmation number.");
      }
      return { externalId: data.confirmationNumber };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError("Sandbox portal timed out.");
      }
      throw err;
    }
  }

  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const key = await this.downstreamKey(personId, idempotencyKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/submissions/${encodeURIComponent(key)}`, {
        signal: controller.signal,
        headers: this.headers(false),
      });
      clearTimeout(timer);
      // Only the contract's explicit absent response means absent. A 200
      // without a confirmation number is malformed: the lookup is
      // unavailable, never "did not happen".
      if (res.status === 404) return { found: false };
      if (!res.ok) throw new Error(`Sandbox portal check failed: ${res.status}`);
      const data = (await res.json()) as { confirmationNumber?: unknown };
      if (typeof data.confirmationNumber === "string" && data.confirmationNumber) {
        return { found: true, externalId: data.confirmationNumber };
      }
      throw new Error("Sandbox portal check returned malformed data: HTTP 200 without a confirmation number.");
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
  SANDBOX_PORTAL_TOKEN?: string;
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
  SANDBOX_PORTAL_TOKEN?: string;
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
    if (!env.SANDBOX_PORTAL_TOKEN) {
      throw new Error("EXECUTOR_MODE is sandbox but SANDBOX_PORTAL_TOKEN is not set.");
    }
    return new SandboxExecutor(env.SANDBOX_BASE_URL.replace(/\/$/, ""), undefined, undefined, env.SANDBOX_PORTAL_TOKEN);
  }
  throw new Error(`Unknown EXECUTOR_MODE: ${mode}.`);
}
