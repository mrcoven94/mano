import { draftFileKey, stagingAttemptKey, submissionFileKey, trackedOwner, type FileStore } from "./files";
import {
  API_SCOPE_PREFIX,
  fromBase64,
  metasToDigests,
  newId,
  packetDigest,
  sha256Hex,
  type FileMeta,
  type Household,
  type SessionData,
  type StagedClaim,
  type Store,
  type Submission,
} from "./store";
import {
  TEST_BANNER,
  caseworkerDetailPage,
  caseworkerListPage,
  documentsPage,
  errorPage,
  homePage,
  householdPage,
  reviewPage,
  savedPage,
  timeoutPage,
} from "./pages";

export interface PortalConfig {
  sessionTimeoutMinutes: number;
  slowMsDefault: number;
  maxUploadBytes: number;
  maxUploadFiles: number;
  maxBodyBytes: number;
  maxFieldLength: number;
  rateLimitPerMinute: number;
  slowMaxConcurrent: number;
  /** Filing token: the caseworker view and the JSON API. Unset means unconfigured. */
  portalToken?: string;
  /** Read-only token for GET /drafts/:id. Unset turns that route off; the filing token also reads drafts. */
  draftToken?: string;
  now?: () => number;
}

export const DEFAULT_CONFIG: PortalConfig = {
  sessionTimeoutMinutes: 15,
  slowMsDefault: 20000,
  maxUploadBytes: 5 * 1024 * 1024,
  maxUploadFiles: 3,
  maxBodyBytes: 24 * 1024 * 1024,
  maxFieldLength: 500,
  rateLimitPerMinute: 60,
  slowMaxConcurrent: 5,
};

const SESSION_COOKIE = "portal_session";
/** Caller-generated draft ids are at least 128 bits of lowercase hex. */
const DRAFT_ID = /^[0-9a-f]{32,128}$/;
const DRAFT_ID_RULE = "A draft number is 32 to 128 lowercase hexadecimal characters.";
const ALLOWED_UPLOAD_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MAX_SLOW_MS = 60000;
const MAX_KEY_LENGTH = 128;
const MAX_FILE_NAME_LENGTH = 200;
const CASEWORKER_PER_PAGE = 25;
export const SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Staging objects outlive no attempt; an hour is far past the slowest one. */
export const STAGED_RETENTION_MS = 60 * 60 * 1000;
const RETIRE_BATCH_LIMIT = 500;

const RATE_WINDOW_MS = 60_000;
const SLOW_LEASE_TTL_MS = 65_000;

type CappedBody = { ok: true; bytes: Uint8Array } | { ok: false };

async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (Number.isInteger(n) && n > maxBytes) return { ok: false };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
}

function tooLargeResponse(asJson: boolean): Response {
  const message = "The request body is larger than this office accepts.";
  return asJson ? json({ error: message }, 413) : html(errorPage("Too large", message, "/", "Back to the home page"), 413);
}

/** Rebuild a form request from capped bytes so formData() never reads the wire itself. */
function formRequestFromBytes(request: Request, bytes: Uint8Array): Request {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Request(request.url, { method: "POST", headers, body: bytes as unknown as BodyInit });
}

/** Longest base64 string that can still decode within the byte cap. */
function maxEncodedLength(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

/**
 * Stage one attempt object: recorded first, then written. If the write fails
 * the record is removed again; if that removal fails too, the sweep still
 * finds the record and deletes whatever the write left behind.
 */
async function stageFile(
  fileStore: FileStore,
  store: Store,
  key: string,
  bytes: Uint8Array,
  type: string,
  now: number,
): Promise<void> {
  await store.trackStaged([{ key, createdAt: now }]);
  try {
    await fileStore.put(key, bytes, type);
  } catch (err) {
    await fileStore.del([key]).catch(() => undefined);
    await store.untrackStaged([key]).catch(() => undefined);
    throw err;
  }
}

/**
 * Release attempt objects: deleted from R2 first, unrecorded only after the
 * delete succeeds, so a failure stays tracked for the cleanup sweep.
 */
async function releaseStaged(fileStore: FileStore, store: Store, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await fileStore.del(keys);
  await store.untrackStaged(keys);
}

/** Attachment header that cannot break out of the filename parameter. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").replace(/[\r\n]/g, "_").trim() || "download";
  return `attachment; filename="${ascii.slice(0, 100)}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 200))}`;
}

type SniffedType = "application/pdf" | "image/png" | "image/jpeg" | null;

/** Read the file signature. The client's declared MIME type is not trusted. */
function sniffType(bytes: Uint8Array): SniffedType {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

function nowMs(config: PortalConfig): number {
  return config.now ? config.now() : Date.now();
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirect(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location, "content-type": "text/html; charset=utf-8" };
  if (setCookie) headers["set-cookie"] = setCookie;
  // Redirects carry a labeled body so clients that do not follow them still see the test banner.
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Continue</title></head><body><p>${TEST_BANNER}</p><p><a href="${location}">Continue</a></p></body></html>`,
    { status: 303, headers },
  );
}

function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readSessionId(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/** JSON callers file in a namespace scoped to their token, so callers never share keys. */
async function callerScope(request: Request): Promise<string> {
  return `${API_SCOPE_PREFIX}${await sha256Hex(bearerToken(request) ?? "")}`;
}

type AuthState = "ok" | "denied" | "unconfigured";

function equalHex(a: string, b: string): boolean {
  // Constant-time compare without platform APIs. Both sides are SHA-256 hex, so lengths match.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A route is on only when its own token is configured; any accepted token then opens it. */
async function authState(request: Request, configured: string | undefined, accepted: Array<string | undefined>): Promise<AuthState> {
  if (!configured) return "unconfigured";
  const presented = bearerToken(request);
  if (!presented) return "denied";
  const hash = await sha256Hex(presented);
  for (const token of accepted) {
    if (token && equalHex(hash, await sha256Hex(token))) return "ok";
  }
  return "denied";
}

function authFailedResponse(path: string, state: AuthState): Response {
  const wantsHtml = !path.startsWith("/submissions") && !path.startsWith("/drafts");
  if (state === "unconfigured") {
    const message = "This portal's access token is not configured, so staff and API access is off.";
    return wantsHtml ? html(errorPage("Not configured", message, "/", "Back to the home page"), 503) : json({ error: message }, 503);
  }
  const message = "A valid access token is required.";
  return wantsHtml
    ? html(errorPage("Sign in required", "Staff and API access needs the portal access token. Put it in the Authorization header as a bearer token.", "/", "Back to the home page"), 401)
    : json({ error: message }, 401);
}

function rateLimitedResponse(path: string): Response {
  const message = "Too many requests. Wait a minute and try again.";
  return path.startsWith("/submissions")
    ? json({ error: message }, 429)
    : html(errorPage("Too many requests", message, "/", "Back to the home page"), 429);
}


async function loadLiveSession(
  request: Request,
  store: Store,
  fileStore: FileStore,
  config: PortalConfig,
): Promise<SessionData | null> {
  const id = readSessionId(request);
  if (!id) return null;
  const session = await store.getSession(id);
  if (!session) return null;
  if (session.expiresAt > nowMs(config)) return session;
  try {
    await releaseStaged(fileStore, store, session.files.map((f) => f.r2key));
  } catch {
    return null;
  }
  await store.deleteSession(id);
  return null;
}

/**
 * Renew a session. Tracking refreshes first: if it throws, the renewal never
 * commits, so a session never points at bytes the sweep took. Null means the
 * session lapsed (or the sweep reaped it) between load and renewal, and the
 * caller must treat it as expired.
 */
async function touchSession(store: Store, session: SessionData, config: PortalConfig): Promise<SessionData | null> {
  const now = nowMs(config);
  if (session.files.length > 0) {
    await store.trackStaged(session.files.map((f) => ({ key: f.r2key, createdAt: now })));
  }
  const fresh: SessionData = {
    ...session,
    expiresAt: now + config.sessionTimeoutMinutes * 60 * 1000,
  };
  const renewed = await store.renewSession(fresh, now);
  return renewed ? fresh : null;
}

function draftInUse(): Response {
  return html(
    errorPage("Draft in use", "This draft number belongs to another application in progress. Start a new application.", "/apply", "Start a new application"),
    409,
  );
}

/** Save the session's household as its draft, expiring on the session timeout. False means another session owns it. */
function saveDraft(store: Store, session: SessionData, household: Household, config: PortalConfig): Promise<boolean> {
  const now = nowMs(config);
  return store.saveDraft({ id: session.draftId, sessionId: session.id, household, savedAt: now, expiresAt: now + config.sessionTimeoutMinutes * 60 * 1000 });
}

function timedOut(): Response {
  return html(timeoutPage(), 403, { "set-cookie": clearSessionCookie() });
}

const HOUSEHOLD_LABELS: Record<keyof Household, string> = {
  fullName: "Full legal name",
  dateOfBirth: "Date of birth",
  address: "Mailing address",
  phone: "Phone number",
  householdSize: "Household size",
  monthlyIncome: "Monthly income",
};

function validateHousehold(
  data: Record<string, string>,
  maxFieldLength: number,
): { household?: Household; error?: string } {
  for (const [field, label] of Object.entries(HOUSEHOLD_LABELS)) {
    if ((data[field] ?? "").length > maxFieldLength) return { error: `${label} is too long.` };
  }
  const household: Household = {
    fullName: (data["fullName"] ?? "").trim(),
    dateOfBirth: (data["dateOfBirth"] ?? "").trim(),
    address: (data["address"] ?? "").trim(),
    phone: (data["phone"] ?? "").trim(),
    householdSize: (data["householdSize"] ?? "").trim(),
    monthlyIncome: (data["monthlyIncome"] ?? "").trim(),
  };
  if (!household.fullName) return { error: "Enter the applicant's full legal name." };
  if (!household.dateOfBirth) return { error: "Enter the applicant's date of birth." };
  if (!household.address) return { error: "Enter the applicant's mailing address." };
  if (!household.phone) return { error: "Enter the applicant's phone number." };
  const size = Number(household.householdSize);
  if (!Number.isInteger(size) || size < 1 || size > 30) {
    return { error: "Household size must be a whole number between 1 and 30." };
  }
  const income = Number(household.monthlyIncome);
  if (household.monthlyIncome === "" || Number.isNaN(income) || income < 0) {
    return { error: "Monthly income must be a number, 0 or more." };
  }
  return { household };
}

async function readUploads(
  form: FormData,
  config: PortalConfig,
  sessionId: string,
  files: FileStore,
  store: Store,
  now: number,
): Promise<{ files?: FileMeta[]; error?: string }> {
  const metas: FileMeta[] = [];
  const staged: string[] = [];
  // Drafts are tracked like attempt staging: a failed rollback stays recorded
  // for the sweep instead of leaking as an untracked object.
  const abort = async (): Promise<void> => {
    await releaseStaged(files, store, staged);
  };
  try {
    for (let i = 1; i <= config.maxUploadFiles; i++) {
      // workers-types declares get() as string-only; at runtime file inputs come back as File.
      const value = form.get(`document${i}`) as unknown as string | File | null;
      if (!(value instanceof File) || (value.size === 0 && !value.name)) continue;
      const name = value.name || `document${i}`;
      if (value.size === 0) {
        await abort();
        return { error: `${name} is empty.` };
      }
      if (name.length > MAX_FILE_NAME_LENGTH) {
        await abort();
        return { error: "A file name is too long." };
      }
      if (!ALLOWED_UPLOAD_TYPES.has(value.type)) {
        await abort();
        return { error: `${name} must be a PDF, PNG or JPG file.` };
      }
      if (value.size > config.maxUploadBytes) {
        await abort();
        return { error: `${name} is larger than the ${config.maxUploadBytes} byte limit.` };
      }
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (sniffType(bytes) !== value.type) {
        await abort();
        return { error: `${name} does not look like a ${value.type === "application/pdf" ? "PDF" : value.type === "image/png" ? "PNG" : "JPG"} file.` };
      }
      const sha256 = await sha256Hex(bytes);
      const r2key = draftFileKey(sessionId, i, sha256);
      await stageFile(files, store, r2key, bytes, value.type, now);
      staged.push(r2key);
      metas.push({ name, type: value.type, size: value.size, sha256, r2key });
    }
  } catch {
    await releaseStaged(files, store, staged).catch(() => undefined);
    throw new Error("upload failed");
  }
  if (metas.length === 0) return { error: "Attach at least one document." };
  return { files: metas };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSlowMs(url: URL, fields: Record<string, string>, config: PortalConfig): number {
  const raw = url.searchParams.get("slowMs") ?? fields["slowMs"];
  if (raw !== undefined && raw !== null && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return Math.max(0, Math.min(MAX_SLOW_MS, Math.floor(parsed)));
  }
  const slowFlag = url.searchParams.get("slow") ?? fields["slow"];
  if (slowFlag === "1" || slowFlag === "true") return config.slowMsDefault;
  return 0;
}

function submissionJson(sub: Submission, duplicate: boolean): Response {
  return json(
    {
      key: sub.key,
      scope: sub.scope,
      status: sub.status,
      confirmationNumber: sub.confirmationNumber,
      digest: sub.digest,
      receivedAt: sub.receivedAt,
      receivedAtIso: new Date(sub.receivedAt).toISOString(),
      duplicate,
    },
    200,
  );
}

function conflictJson(stored: Pick<Submission, "key" | "scope" | "confirmationNumber" | "digest" | "receivedAt">): Response {
  return json(
    {
      error: "This key already filed a different application. Use a new key for a new application.",
      key: stored.key,
      received: {
        scope: stored.scope,
        confirmationNumber: stored.confirmationNumber,
        digest: stored.digest,
        receivedAt: stored.receivedAt,
        receivedAtIso: new Date(stored.receivedAt).toISOString(),
      },
    },
    409,
  );
}

interface JsonUpload {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/**
 * File one application. Only the JSON API with the filing token reaches
 * here; the browser saves drafts and never files.
 */
async function handleSubmit(
  request: Request,
  url: URL,
  store: Store,
  fileStore: FileStore,
  config: PortalConfig,
): Promise<Response> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return json({ error: "Submissions are JSON from the office's filing service. The browser saves drafts only." }, 415);
  }
  const fields: Record<string, string> = {};
  let household: Household | null = null;
  const uploads: JsonUpload[] = [];

  const capped = await readCappedBody(request, config.maxBodyBytes);
  if (!capped.ok) return tooLargeResponse(true);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(capped.bytes));
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Request body must be an object." }, 400);
  }
  const record = body as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = String(v);
  }
  if (record["household"] !== undefined) {
    const raw = record["household"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return json({ error: "household must be an object." }, 400);
    }
    const strings: Record<string, string> = {};
    for (const [field, label] of Object.entries(HOUSEHOLD_LABELS)) {
      const value = (raw as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (typeof value !== "string") return json({ error: `${label} must be a string.` }, 400);
      strings[field] = value;
    }
    const parsed = validateHousehold(strings, config.maxFieldLength);
    if (!parsed.household) return json({ error: parsed.error }, 400);
    household = parsed.household;
  }
  if (record["files"] !== undefined) {
    if (!Array.isArray(record["files"])) return json({ error: "files must be an array." }, 400);
    if (record["files"].length > config.maxUploadFiles) {
      return json({ error: `Attach at most ${config.maxUploadFiles} files.` }, 400);
    }
    for (const entry of record["files"] as Array<Record<string, unknown>>) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return json({ error: "Each file needs a name, type and base64 data." }, 400);
      }
      if (typeof entry["name"] !== "string" || typeof entry["type"] !== "string" || typeof entry["data"] !== "string") {
        return json({ error: "Each file needs a name, type and base64 data." }, 400);
      }
      if (entry["name"].length > MAX_FILE_NAME_LENGTH) {
        return json({ error: "A file name is too long." }, 400);
      }
      if (entry["data"].length > maxEncodedLength(config.maxUploadBytes)) {
        return json({ error: `${entry["name"]} is larger than the ${config.maxUploadBytes} byte limit.` }, 400);
      }
      if (!ALLOWED_UPLOAD_TYPES.has(entry["type"])) {
        return json({ error: `${entry["name"]} must be a PDF, PNG or JPG file.` }, 400);
      }
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(entry["data"]);
      } catch {
        return json({ error: `${entry["name"]} is not valid base64.` }, 400);
      }
      if (bytes.length === 0) {
        return json({ error: `${entry["name"]} is empty.` }, 400);
      }
      if (bytes.length > config.maxUploadBytes) {
        return json({ error: `${entry["name"]} is larger than the ${config.maxUploadBytes} byte limit.` }, 400);
      }
      if (sniffType(bytes) !== entry["type"]) {
        return json({ error: `${entry["name"]} does not look like its declared file type.` }, 400);
      }
      uploads.push({ name: entry["name"], type: entry["type"], bytes });
    }
  }

  const key = (fields["key"] ?? "").trim();
  if (!key) return json({ error: "A submission key is required." }, 400);
  if (key.length > MAX_KEY_LENGTH) return json({ error: "The submission key is too long." }, 400);
  if (!household) return json({ error: "A JSON submission needs a household object." }, 400);
  if (uploads.length === 0) return json({ error: "Attach at least one document." }, 400);

  // A key belongs to the scope that created it: callers see only their token's scope.
  const scope = await callerScope(request);
  const attemptId = newId();
  const files: FileMeta[] = [];
  // Staged sources paired with the filed keys they fill on success.
  const copies: Array<{ from: string; to: string }> = [];
  // Objects this attempt created and may delete. Filed keys are never deleted here.
  const stagedKeys: string[] = [];
  try {
    for (let i = 0; i < uploads.length; i++) {
      const upload = uploads[i]!;
      const sha256 = await sha256Hex(upload.bytes);
      const staged = stagingAttemptKey(attemptId, i + 1, sha256);
      await stageFile(fileStore, store, staged, upload.bytes, upload.type, nowMs(config));
      stagedKeys.push(staged);
      const r2key = submissionFileKey(scope, key, i + 1, sha256);
      copies.push({ from: staged, to: r2key });
      files.push({ name: upload.name, type: upload.type, size: upload.bytes.length, sha256, r2key });
    }
  } catch {
    await releaseStaged(fileStore, store, stagedKeys).catch(() => undefined);
    return json({ error: "The office could not store the attachments. Try again." }, 500);
  }

  const slowMs = resolveSlowMs(url, fields, config);
  const digest = await packetDigest(household, metasToDigests(files));
  let lease: string | null = null;
  const fail = async (status: number, message: string): Promise<Response> => {
    await releaseStaged(fileStore, store, stagedKeys).catch(() => undefined);
    if (lease) await store.endSlow(lease);
    return json({ error: message }, status);
  };
  if (slowMs > 0) {
    lease = await store.tryBeginSlow(nowMs(config), SLOW_LEASE_TTL_MS, config.slowMaxConcurrent);
    if (!lease) return fail(503, "The office is holding too many slow responses. Try again in a moment.");
  }
  // The destination keys are tracked and held before any byte lands on them,
  // so the sweep cannot take a copy before its row exists. Attachments land
  // on their final keys before the receipt exists, so a copy failure leaves
  // not_found instead of a received row with missing bytes. Copies are
  // idempotent: twins write identical bytes to identical keys, and a missing
  // source with a present target means a twin attempt already copied.
  let held = false;
  try {
    held = await store.holdForFiling(attemptId, copies.map((c) => ({ key: c.to, createdAt: nowMs(config) })), nowMs(config) + STAGED_RETENTION_MS);
    if (held) {
      for (const pair of copies) {
        const bytes = await fileStore.get(pair.from);
        if (!bytes) {
          const twin = await fileStore.get(pair.to);
          if (!twin) throw new Error(`staged object missing: ${pair.from}`);
          continue;
        }
        await fileStore.put(pair.to, bytes.data, bytes.type);
      }
    }
  } catch {
    // The destination keys stay tracked: once the hold is gone and no row
    // references them, the sweep deletes whatever the failed copy left behind.
    await store.releaseHolds(attemptId).catch(() => undefined);
    return fail(500, "The office could not store the attachments. Try again.");
  }
  // A key still waiting on its R2 delete could lose bytes written now to that delete.
  if (!held) return fail(503, "The office is still clearing an earlier copy of these attachments. Try again in a minute.");

  try {
    const result = await store.submit({ key, scope, household, files, digest, slowMs, receivedAt: nowMs(config) });
    if (result.outcome === "conflict" || result.outcome === "conflict-retired") {
      // A losing attempt never deletes its filed copies itself: a re-read then
      // delete still races a new winner filing under this key. The copies stay
      // tracked, and the sweep deletes them only while no submission row
      // references them, which is the same guard that decided this attempt lost.
      await releaseStaged(fileStore, store, stagedKeys).catch(() => undefined);
      if (lease) await store.endSlow(lease);
      return conflictJson(result.outcome === "conflict" ? result.stored : result.receipt);
    }
    if (result.outcome === "duplicate-retired") {
      // Same as a losing attempt: the copies stay tracked for the guarded sweep.
      await releaseStaged(fileStore, store, stagedKeys).catch(() => undefined);
      if (lease) await store.endSlow(lease);
      const kept = result.receipt;
      return json(
        {
          key: kept.key,
          scope: kept.scope,
          status: "received",
          confirmationNumber: kept.confirmationNumber,
          digest: kept.digest,
          receivedAt: kept.receivedAt,
          receivedAtIso: new Date(kept.receivedAt).toISOString(),
          duplicate: true,
          retired: true,
        },
        200,
      );
    }
    const duplicate = result.outcome === "duplicate";
    // The winner's row owns the filed copies now, so they leave tracking; a
    // duplicate's copies are identical bytes on the same keys. If the untrack
    // fails the sweep still spares them while the row references them.
    await store.untrackStaged(copies.map((c) => c.to)).catch(() => undefined);
    await releaseStaged(fileStore, store, stagedKeys).catch(() => undefined);
    if (slowMs > 0 && !duplicate) await sleep(slowMs);
    if (lease) await store.endSlow(lease);
    return submissionJson(result.submission, duplicate);
  } finally {
    await store.releaseHolds(attemptId).catch(() => undefined);
  }
}

export interface CleanupReport {
  expiredSessions: number;
  expiredDrafts: number;
  retiredFiles: number;
  purgedReceipts: number;
  sweptStaged: number;
}

/**
 * Scheduled cleanup. Drafts go after their session lapses; submissions and
 * their files go after 7 days, leaving a small receipt for 30 days so a late
 * reconcile never sees not_found for something that was filed. A tracked
 * object goes only when nothing references it: the session and submission
 * guards decide by live reference or filing hold, not age. Every claim checks
 * its guard in the same statement as the untrack, so a renewal or hold that
 * lands first always wins. A claimed object stays recorded as a pending delete
 * until R2 confirms, so a failed or interrupted delete is retried next run.
 */
export async function runCleanup(store: Store, fileStore: FileStore, now: number): Promise<CleanupReport> {
  const expired = await store.listExpiredSessions(now);
  // The listing is a snapshot: each row is re-checked inside its own delete,
  // so a touch that landed after the listing keeps its session and drafts.
  const reaped: SessionData[] = [];
  for (const session of expired) {
    const gone = await store.deleteSessionIfExpired(session.id, now);
    if (gone) reaped.push(gone);
  }
  await releaseStaged(fileStore, store, reaped.flatMap((s) => s.files.map((f) => f.r2key)));
  const old = await store.listOldSubmissions(now - SUBMISSION_RETENTION_MS, RETIRE_BATCH_LIMIT);
  await store.writeReceipts(
    old.map((sub) => ({
      key: sub.key,
      scope: sub.scope,
      confirmationNumber: sub.confirmationNumber,
      digest: sub.digest,
      receivedAt: sub.receivedAt,
    })),
  );
  const retiredKeys = old.flatMap((sub) => sub.files.map((f) => f.r2key));
  await fileStore.del(retiredKeys);
  await store.deleteSubmissions(old.map((sub) => ({ scope: sub.scope, key: sub.key })));
  const tracked = await store.listTrackedStaged();
  const claims: StagedClaim[] = tracked.map((entry) => {
    const owner = trackedOwner(entry.key);
    if (owner.kind === "session") return { key: entry.key, guard: { kind: "session", sessionId: owner.sessionId, now } };
    if (owner.kind === "submission") return { key: entry.key, guard: { kind: "submission", scope: owner.scope, key: owner.key, now } };
    return { key: entry.key, guard: { kind: "attempt", olderThan: now - STAGED_RETENTION_MS } };
  });
  await store.claimUnreferencedStaged(claims);
  await store.purgeExpiredHolds(now);
  await store.purgeExpiredSlowLeases(now);
  const purgedReceipts = await store.purgeOldReceipts(now - RECEIPT_RETENTION_MS);
  const expiredDrafts = await store.purgeExpiredDrafts(now);
  const doomed = await store.listPendingDeletes();
  await fileStore.del(doomed);
  await store.clearPendingDeletes(doomed);
  return { expiredSessions: reaped.length, expiredDrafts, retiredFiles: retiredKeys.length, purgedReceipts, sweptStaged: doomed.length };
}

export async function handleRequest(request: Request, store: Store, fileStore: FileStore, config: PortalConfig): Promise<Response> {
  const res = await routeRequest(request, store, fileStore, config);
  const headers = new Headers(res.headers);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function routeRequest(request: Request, store: Store, fileStore: FileStore, config: PortalConfig): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed = await store.checkRateLimit(ip, nowMs(config), RATE_WINDOW_MS, config.rateLimitPerMinute);
  if (!allowed) return rateLimitedResponse(path);
  // Filing, reconciling and the caseworker view take the filing token only.
  if (path === "/caseworker" || path.startsWith("/caseworker/") || path.startsWith("/submissions")) {
    const auth = await authState(request, config.portalToken, [config.portalToken]);
    if (auth !== "ok") return authFailedResponse(path, auth);
  }
  // Draft reads take the read-only draft token, or the filing token, and are off without the draft token.
  if (path.startsWith("/drafts")) {
    const auth = await authState(request, config.draftToken, [config.draftToken, config.portalToken]);
    if (auth !== "ok") return authFailedResponse(path, auth);
  }

  if (method === "GET" && path === "/") return html(homePage());

  if (method === "GET" && path === "/apply") {
    const draftId = url.searchParams.get("draft");
    if (draftId !== null && !DRAFT_ID.test(draftId)) return html(errorPage("Bad draft number", DRAFT_ID_RULE, "/apply", "Start over"), 400);
    return html(householdPage(draftId));
  }

  if (method === "POST" && path === "/apply/household") {
    const capped = await readCappedBody(request, config.maxBodyBytes);
    if (!capped.ok) return tooLargeResponse(false);
    const form = await formRequestFromBytes(request, capped.bytes).formData();
    const fields: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
    }
    const requested = fields["draft"] || null;
    if (requested !== null && !DRAFT_ID.test(requested)) return html(householdPage(null, DRAFT_ID_RULE, fields), 400);
    const parsed = validateHousehold(fields, config.maxFieldLength);
    if (!parsed.household) return html(householdPage(requested, parsed.error, fields), 400);
    let session = await loadLiveSession(request, store, fileStore, config);
    const draftId = requested ?? session?.draftId ?? newId();
    let isNew = false;
    if (!session || session.draftId !== draftId) {
      // A different draft starts a fresh session; the old row expires on its own.
      session = { id: newId(), draftId, files: [], createdAt: nowMs(config), expiresAt: 0 };
      isNew = true;
    }
    session.household = parsed.household;
    if (!(await saveDraft(store, session, parsed.household, config))) return draftInUse();
    if (isNew) {
      // A new session has no row to renew; it is created, never renewed.
      session.expiresAt = nowMs(config) + config.sessionTimeoutMinutes * 60 * 1000;
      await store.putSession(session);
      return redirect("/apply/documents", sessionCookie(session.id));
    }
    const fresh = await touchSession(store, session, config);
    if (!fresh) return timedOut();
    return redirect("/apply/documents", sessionCookie(fresh.id));
  }

  if (method === "GET" && path === "/apply/documents") {
    const session = await loadLiveSession(request, store, fileStore, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    if (!(await touchSession(store, session, config))) return timedOut();
    return html(documentsPage());
  }

  if (method === "POST" && path === "/apply/documents") {
    const session = await loadLiveSession(request, store, fileStore, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    const capped = await readCappedBody(request, config.maxBodyBytes);
    if (!capped.ok) return tooLargeResponse(false);
    const form = await formRequestFromBytes(request, capped.bytes).formData();
    let parsed: { files?: FileMeta[]; error?: string };
    try {
      parsed = await readUploads(form, config, session.id, fileStore, store, nowMs(config));
    } catch {
      return html(errorPage("Upload failed", "The office could not store the attachments. Try again.", "/apply/documents", "Back to documents"), 500);
    }
    if (!parsed.files) {
      if (!(await touchSession(store, session, config))) return timedOut();
      return html(documentsPage(parsed.error), 400);
    }
    // Replacing the draft drops the previous draft objects. If that fails the
    // session keeps pointing at them and the new drafts go away instead.
    const replaced = session.files.map((f) => f.r2key).filter((k) => !parsed.files!.some((f) => f.r2key === k));
    try {
      await releaseStaged(fileStore, store, replaced);
    } catch {
      await releaseStaged(fileStore, store, parsed.files!.map((f) => f.r2key)).catch(() => undefined);
      return html(errorPage("Upload failed", "The office could not store the attachments. Try again.", "/apply/documents", "Back to documents"), 500);
    }
    session.files = parsed.files;
    if (!(await touchSession(store, session, config))) return timedOut();
    return redirect("/apply/review");
  }

  if (method === "GET" && path === "/apply/review") {
    const session = await loadLiveSession(request, store, fileStore, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    if (session.files.length === 0) return redirect("/apply/documents");
    if (!(await touchSession(store, session, config))) return timedOut();
    return html(reviewPage(session.household, session.files));
  }

  // The browser's Submit saves the draft and files nothing.
  if (method === "POST" && path === "/apply/submit") {
    const session = await loadLiveSession(request, store, fileStore, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    if (session.files.length === 0) return redirect("/apply/documents");
    if (!(await saveDraft(store, session, session.household, config))) return draftInUse();
    if (!(await touchSession(store, session, config))) return timedOut();
    return html(savedPage(session.draftId));
  }

  const draftMatch = /^\/drafts\/([^/]+)$/.exec(path);
  if (method === "GET" && draftMatch?.[1]) {
    const id = draftMatch[1];
    if (!DRAFT_ID.test(id)) return json({ error: DRAFT_ID_RULE }, 400);
    const draft = await store.getDraft(id, nowMs(config));
    if (!draft) return json({ id, status: "not_found" }, 404);
    const h = draft.household;
    return json({
      id: draft.id,
      household: {
        fullName: h.fullName,
        dateOfBirth: h.dateOfBirth,
        address: h.address,
        phone: h.phone,
        householdSize: h.householdSize,
        monthlyIncome: h.monthlyIncome,
      },
      savedAt: draft.savedAt,
    });
  }

  if (method === "POST" && path === "/submissions") {
    return handleSubmit(request, url, store, fileStore, config);
  }

  const submissionMatch = /^\/submissions\/([^/]+)$/.exec(path);
  if (method === "GET" && submissionMatch?.[1]) {
    const key = decodeURIComponent(submissionMatch[1]);
    const scope = await callerScope(request);
    const sub = await store.getSubmission(scope, key);
    if (sub) {
      return json({
        key: sub.key,
        scope: sub.scope,
        status: sub.status,
        confirmationNumber: sub.confirmationNumber,
        digest: sub.digest,
        receivedAt: sub.receivedAt,
        receivedAtIso: new Date(sub.receivedAt).toISOString(),
      });
    }
    const receipt = await store.getReceipt(scope, key);
    if (receipt) {
      return json({
        key: receipt.key,
        scope: receipt.scope,
        status: "received",
        confirmationNumber: receipt.confirmationNumber,
        digest: receipt.digest,
        receivedAt: receipt.receivedAt,
        receivedAtIso: new Date(receipt.receivedAt).toISOString(),
        retired: true,
      });
    }
    return json({ key, status: "not_found" }, 404);
  }

  if (method === "GET" && path === "/caseworker") {
    const total = await store.countSubmissions();
    const totalPages = Math.max(1, Math.ceil(total / CASEWORKER_PER_PAGE));
    const asked = Number(url.searchParams.get("page") ?? "1");
    const page = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, totalPages) : 1;
    const subs = await store.listSubmissionSummaries(CASEWORKER_PER_PAGE, (page - 1) * CASEWORKER_PER_PAGE);
    return html(caseworkerListPage(subs, page, totalPages));
  }

  const fileMatch = /^\/caseworker\/([^/]+)\/file\/(\d+)$/.exec(path);
  if (method === "GET" && fileMatch?.[1] && fileMatch[2] !== undefined) {
    const sub = await store.getSubmissionByConfirmation(decodeURIComponent(fileMatch[1]));
    const file = sub?.files[Number(fileMatch[2])];
    if (!sub || !file) {
      return html(errorPage("Not found", "That file does not exist.", "/caseworker", "Back to the list"), 404);
    }
    const bytes = await fileStore.get(file.r2key);
    if (!bytes) {
      return html(errorPage("Not found", "That file does not exist.", "/caseworker", "Back to the list"), 404);
    }
    return new Response(bytes.data as unknown as BodyInit, {
      headers: {
        "content-type": file.type,
        "content-disposition": contentDisposition(file.name),
      },
    });
  }

  const caseMatch = /^\/caseworker\/([^/]+)$/.exec(path);
  if (method === "GET" && caseMatch?.[1]) {
    const sub = await store.getSubmissionByConfirmation(decodeURIComponent(caseMatch[1]));
    if (!sub) {
      return html(errorPage("Not found", "That confirmation number does not exist.", "/caseworker", "Back to the list"), 404);
    }
    return html(caseworkerDetailPage(sub));
  }

  return html(errorPage("Not found", "That page does not exist on this test portal.", "/", "Back to the home page"), 404);
}
