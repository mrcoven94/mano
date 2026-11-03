import type { ActionRequest, ActionType, CheckOutcome, DocumentFiling, Executor, StoredDocumentFacts } from "./types.js";
import { DefiniteFailureError, TimeoutError } from "./types.js";
import { boundFetch } from "../fetch.js";
import { base64ToBytes, sha256Hex } from "../hash.js";

// In-memory stand-in: records calls, invents external IDs, and can fail
// once with a timeout for reconcile tests. Receipts are always labeled
// simulated so a drill never reads as real filing. It judges documents by
// the portal's limits, so Mano picks the same proof a sandbox deploy would.
export class InMemoryExecutor implements Executor {
  readonly simulated = true;
  calls: ActionRequest[] = [];
  completed = new Map<string, { externalId: string }>();
  failNextWithTimeout = false;

  constructor(private limits: PortalLimits = DEFAULT_PORTAL_LIMITS) {}

  documentFiling(doc: StoredDocumentFacts): DocumentFiling {
    return documentFiling(doc, this.limits);
  }

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
// with { key, household, declaration, files } answers { confirmationNumber }, which
// becomes the receipt's external ID. GET {base}/submissions/{key} answers
// it again, or 404 when the key never filed. The portal dedupes on the
// key, which is the SHA-256 of "<personId>:<idempotencyKey>" so it is
// scoped to the person and fits the portal's 128-character limit.
// Receipts from this executor are real filings into the sandbox, never
// simulated.

// What the portal's POST /submissions accepts: handleSubmit,
// validateHousehold and sniffType in apps/sandbox-portal/src/app.ts.
// portalFiling is the one place the executor applies it, both when the
// gateway asks before drafting an approval and again right before filing.
// The contract test runs these rules against the real portal code.
const TRAILING_SLASH = /\/$/;
const PORTAL_HOUSEHOLD = {
  caseNumber: "case number",
  fullName: "full legal name",
  dateOfBirth: "date of birth",
  address: "mailing address",
  phone: "phone number",
  householdSize: "household size",
  monthlyIncome: "monthly income",
} as const;
type HouseholdField = keyof typeof PORTAL_HOUSEHOLD;
// The declaration a renewal ends with (DECLARATION in
// apps/sandbox-portal/src/store.ts). The approval the person answers
// carries it word for word under this payload key, so their YES is what
// makes it; the filing then carries it as the applicant's own.
export const PORTAL_DECLARATION =
  "I declare under penalty of perjury that the information in this renewal is true, correct and complete to the best of my knowledge.";
const DECLARATION_KEY = "declaration";
// The portal reads its limits from MAX_FIELD_LENGTH and MAX_UPLOAD_BYTES;
// the engine names the same numbers as SANDBOX_MAX_FIELD_LENGTH and
// SANDBOX_MAX_UPLOAD_BYTES, and a test fails when the two wrangler.toml
// files disagree. The defaults are the portal's defaults.
export interface PortalLimits {
  maxFieldLength: number;
  maxDocumentBytes: number;
}
export const DEFAULT_PORTAL_LIMITS: PortalLimits = { maxFieldLength: 500, maxDocumentBytes: 5 * 1024 * 1024 };

function describeBytes(n: number): string {
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} bytes`;
}
const PORTAL_DOCUMENT_TYPES = [
  { type: "application/pdf", ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
] as const;
const NOT_FILED: Record<Exclude<ActionType, "submit">, string> = {
  send: "send a message",
  call: "make a phone call",
  fax: "send a fax",
  share: "share a case",
};

// Whether the portal takes a document of this media type and size: the
// check portalFiling applies to the bytes, and the document list applies
// to what Engine recorded when it stored them.
export function documentFiling(doc: StoredDocumentFacts, limits: PortalLimits): DocumentFiling {
  if (!PORTAL_DOCUMENT_TYPES.some((k) => k.type === doc.mediaType)) return "wrong_type";
  if (doc.sizeBytes === null) return "size_unknown";
  return doc.sizeBytes > limits.maxDocumentBytes ? "too_large" : "fileable";
}

type PortalFiling =
  | { ok: true; household: Record<HouseholdField, string>; file: { name: string; type: string; data: string } }
  | { ok: false; problem: string };

function portalFiling(req: ActionRequest, limits: PortalLimits): PortalFiling {
  if (req.type !== "submit") {
    return { ok: false, problem: `The sandbox agency portal only takes filed applications, so Mano cannot ${NOT_FILED[req.type]} there.` };
  }
  const household = {} as Record<HouseholdField, string>;
  for (const field of Object.keys(PORTAL_HOUSEHOLD) as HouseholdField[]) {
    const raw = req.payload[field];
    const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    if (value.length > limits.maxFieldLength) {
      return { ok: false, problem: `The applicant's ${PORTAL_HOUSEHOLD[field]} is longer than the sandbox agency portal accepts.` };
    }
    if (!value.trim()) return { ok: false, problem: `The sandbox agency portal needs the applicant's ${PORTAL_HOUSEHOLD[field]}.` };
    household[field] = value;
  }
  const size = Number(household.householdSize.trim());
  if (!Number.isInteger(size) || size < 1 || size > 30) {
    return { ok: false, problem: "The sandbox agency portal needs a household size that is a whole number from 1 to 30." };
  }
  const income = Number(household.monthlyIncome.trim());
  if (Number.isNaN(income) || income < 0) {
    return { ok: false, problem: "The sandbox agency portal needs a monthly income that is a number, 0 or more." };
  }
  if (req.payload[DECLARATION_KEY] !== PORTAL_DECLARATION) {
    return { ok: false, problem: "The renewal must show the person the office's declaration word for word, for them to make themselves." };
  }
  if (!req.document) {
    return { ok: false, problem: "The sandbox agency portal needs at least one document attached, such as a photo of the letter." };
  }
  const bytes = base64ToBytes(req.document.bytesB64);
  const kind = PORTAL_DOCUMENT_TYPES.find((k) => bytes.length >= k.magic.length && k.magic.every((b, i) => bytes[i] === b));
  const filing = documentFiling({ mediaType: kind?.type ?? null, sizeBytes: bytes.length }, limits);
  if (filing === "too_large") {
    return { ok: false, problem: `The document is larger than the ${describeBytes(limits.maxDocumentBytes)} the sandbox agency portal accepts.` };
  }
  if (!kind) return { ok: false, problem: "The sandbox agency portal takes PDF, PNG or JPG documents only." };
  return { ok: true, household, file: { name: `document-1.${kind.ext}`, type: kind.type, data: req.document.bytesB64 } };
}

export class SandboxExecutor implements Executor {
  readonly simulated = false;
  calls: ActionRequest[] = [];

  constructor(
    private baseUrl: string,
    private timeoutMs = 15000,
    private fetchFn: typeof fetch = boundFetch,
    private token?: string,
    private limits: PortalLimits = DEFAULT_PORTAL_LIMITS,
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

  refuse(req: ActionRequest): string | null {
    const filing = portalFiling(req, this.limits);
    return filing.ok ? null : filing.problem;
  }

  documentFiling(doc: StoredDocumentFacts): DocumentFiling {
    return documentFiling(doc, this.limits);
  }

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    this.calls.push(req);
    // The gateway already asked before the approval. This covers an
    // approval drafted before that check existed or under another mode.
    const filing = portalFiling(req, this.limits);
    if (!filing.ok) throw new DefiniteFailureError(filing.problem);
    // Mano never makes the declaration: only the person's own YES to the
    // request that showed it does.
    if (!req.answeredBy || req.answeredBy !== req.personId) {
      throw new DefiniteFailureError("Only the applicant can make the renewal's declaration, and they have not answered it.");
    }
    const body = {
      key: await this.downstreamKey(req.personId, req.idempotencyKey),
      household: filing.household,
      declaration: { statement: PORTAL_DECLARATION, madeBy: "applicant" },
      files: [filing.file],
    };
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

function portalLimit(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0.`);
  return n;
}

// Picks the executor from config. Simulated must be an explicit choice:
// EXECUTOR_MODE=simulated set on purpose, or unset in development. Outside
// development with no choice made, construction fails loud instead of
// silently simulating.
export function createExecutor(env: {
  EXECUTOR_MODE?: string;
  SANDBOX_BASE_URL?: string;
  SANDBOX_PORTAL_TOKEN?: string;
  SANDBOX_MAX_FIELD_LENGTH?: string;
  SANDBOX_MAX_UPLOAD_BYTES?: string;
  MANO_ENV?: string;
}): Executor {
  if (testFactory) return testFactory(env);
  const mode = env.EXECUTOR_MODE;
  const limits: PortalLimits = {
    maxFieldLength: portalLimit("SANDBOX_MAX_FIELD_LENGTH", env.SANDBOX_MAX_FIELD_LENGTH, DEFAULT_PORTAL_LIMITS.maxFieldLength),
    maxDocumentBytes: portalLimit("SANDBOX_MAX_UPLOAD_BYTES", env.SANDBOX_MAX_UPLOAD_BYTES, DEFAULT_PORTAL_LIMITS.maxDocumentBytes),
  };
  if (mode === "simulated") return new InMemoryExecutor(limits);
  if (mode === undefined && env.MANO_ENV === "development") return new InMemoryExecutor(limits);
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
    return new SandboxExecutor(env.SANDBOX_BASE_URL.replace(TRAILING_SLASH, ""), undefined, undefined, env.SANDBOX_PORTAL_TOKEN, limits);
  }
  throw new Error(`Unknown EXECUTOR_MODE: ${mode}.`);
}
