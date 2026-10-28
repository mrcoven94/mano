import { draftFileKey, submissionFileKey, type FileStore } from "./files";
import {
  fromBase64,
  metasToDigests,
  newId,
  packetDigest,
  sha256Hex,
  type FileMeta,
  type Household,
  type SessionData,
  type Store,
  type Submission,
} from "./store";
import {
  TEST_BANNER,
  caseworkerDetailPage,
  caseworkerListPage,
  confirmationPage,
  documentsPage,
  errorPage,
  homePage,
  householdPage,
  reviewPage,
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
  /** Expected bearer token for the caseworker view and the JSON API. Unset means unconfigured. */
  portalToken?: string;
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
export const WEB_SCOPE = "web";
const ALLOWED_UPLOAD_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MAX_SLOW_MS = 60000;
const MAX_KEY_LENGTH = 128;
const MAX_FILE_NAME_LENGTH = 200;
const CASEWORKER_PER_PAGE = 25;
export const SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

function wantsJson(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  const accept = request.headers.get("accept") ?? "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/** JSON callers file in a namespace scoped to their token, so callers never share keys. */
async function callerScope(request: Request): Promise<string> {
  return `api-${await sha256Hex(bearerToken(request) ?? "")}`;
}

type AuthState = "ok" | "denied" | "unconfigured";

function equalHex(a: string, b: string): boolean {
  // Constant-time compare without platform APIs. Both sides are SHA-256 hex, so lengths match.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authState(request: Request, config: PortalConfig): Promise<AuthState> {
  if (!config.portalToken) return "unconfigured";
  const presented = bearerToken(request);
  if (!presented) return "denied";
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(config.portalToken)]);
  return equalHex(a, b) ? "ok" : "denied";
}

function authFailedResponse(path: string, state: AuthState): Response {
  const wantsHtml = !path.startsWith("/submissions");
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

function slowBusyResponse(wantsHtml: boolean): Response {
  const message = "The office is holding too many slow responses. Try again in a moment.";
  return wantsHtml
    ? html(errorPage("Office busy", message, "/apply/review", "Back to review"), 503)
    : json({ error: message }, 503);
}

async function loadSession(request: Request, store: Store, config: PortalConfig): Promise<SessionData | null> {
  const id = readSessionId(request);
  if (!id) return null;
  const session = await store.getSession(id);
  if (!session) return null;
  if (session.expiresAt <= nowMs(config)) {
    await store.deleteSession(id);
    return null;
  }
  return session;
}

async function touchSession(store: Store, session: SessionData, config: PortalConfig): Promise<SessionData> {
  const fresh: SessionData = {
    ...session,
    expiresAt: nowMs(config) + config.sessionTimeoutMinutes * 60 * 1000,
  };
  await store.putSession(fresh);
  return fresh;
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
): Promise<{ files?: FileMeta[]; error?: string }> {
  const metas: FileMeta[] = [];
  const staged: string[] = [];
  for (let i = 1; i <= config.maxUploadFiles; i++) {
    // workers-types declares get() as string-only; at runtime file inputs come back as File.
    const value = form.get(`document${i}`) as unknown as string | File | null;
    if (!(value instanceof File) || value.size === 0) continue;
    const name = value.name || `document${i}`;
    if (name.length > MAX_FILE_NAME_LENGTH) {
      await files.del(staged);
      return { error: "A file name is too long." };
    }
    if (!ALLOWED_UPLOAD_TYPES.has(value.type)) {
      await files.del(staged);
      return { error: `${name} must be a PDF, PNG or JPG file.` };
    }
    if (value.size > config.maxUploadBytes) {
      await files.del(staged);
      return { error: `${name} is larger than the ${config.maxUploadBytes} byte limit.` };
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    const r2key = draftFileKey(sessionId, i, sha256);
    await files.put(r2key, bytes, value.type);
    staged.push(r2key);
    metas.push({ name, type: value.type, size: value.size, sha256, r2key });
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

function conflictJson(stored: Submission): Response {
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

async function handleSubmit(
  request: Request,
  url: URL,
  store: Store,
  fileStore: FileStore,
  config: PortalConfig,
): Promise<Response> {
  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  let fields: Record<string, string> = {};
  let jsonHousehold: Household | null = null;
  let jsonUploads: JsonUpload[] | null = null;

  if (isJson) {
    const capped = await readCappedBody(request, config.maxBodyBytes);
    if (!capped.ok) return tooLargeResponse(true);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(capped.bytes));
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400);
    }
    if (typeof body !== "object" || body === null) return json({ error: "Request body must be an object." }, 400);
    const record = body as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = String(v);
    }
    if (record["household"] !== undefined) {
      const parsed = validateHousehold((record["household"] ?? {}) as Record<string, string>, config.maxFieldLength);
      if (!parsed.household) return json({ error: parsed.error }, 400);
      jsonHousehold = parsed.household;
    }
    if (record["files"] !== undefined) {
      if (!Array.isArray(record["files"])) return json({ error: "files must be an array." }, 400);
      if (record["files"].length > config.maxUploadFiles) {
        return json({ error: `Attach at most ${config.maxUploadFiles} files.` }, 400);
      }
      jsonUploads = [];
      for (const entry of record["files"] as Array<Record<string, unknown>>) {
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
        if (bytes.length > config.maxUploadBytes) {
          return json({ error: `${entry["name"]} is larger than the ${config.maxUploadBytes} byte limit.` }, 400);
        }
        jsonUploads.push({ name: entry["name"], type: entry["type"], bytes });
      }
    }
  } else {
    const capped = await readCappedBody(request, config.maxBodyBytes);
    if (!capped.ok) return tooLargeResponse(wantsJson(request));
    const form = await formRequestFromBytes(request, capped.bytes).formData();
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
    }
  }

  const key = (fields["key"] ?? "").trim();
  if (!key) {
    const message = "A submission key is required.";
    return isJson || wantsJson(request) ? json({ error: message }, 400) : html(errorPage("Missing key", message, "/apply/review", "Back to review"), 400);
  }
  if (key.length > MAX_KEY_LENGTH) {
    const message = "The submission key is too long.";
    return isJson || wantsJson(request) ? json({ error: message }, 400) : html(errorPage("Bad key", message, "/apply/review", "Back to review"), 400);
  }

  let household: Household | undefined;
  let files: FileMeta[] = [];
  let source: Submission["source"] = "web";
  let session: SessionData | null = null;
  let scope = WEB_SCOPE;
  let reviewedDigest = "";
  let uploadedKeys: string[] = [];

  if (isJson) {
    source = "api";
    if (!jsonHousehold) return json({ error: "A JSON submission needs a household object." }, 400);
    const uploads = jsonUploads ?? [];
    if (uploads.length === 0) return json({ error: "Attach at least one document." }, 400);
    scope = await callerScope(request);
    household = jsonHousehold;
    for (let i = 0; i < uploads.length; i++) {
      const upload = uploads[i]!;
      const sha256 = await sha256Hex(upload.bytes);
      const r2key = submissionFileKey(scope, key, i + 1, sha256);
      await fileStore.put(r2key, upload.bytes, upload.type);
      uploadedKeys.push(r2key);
      files.push({ name: upload.name, type: upload.type, size: upload.bytes.length, sha256, r2key });
    }
  } else {
    session = await loadSession(request, store, config);
    if (!session) return timedOut();
    if (key !== session.key) {
      return html(
        errorPage(
          "Wrong key",
          "This form's key belongs to a different session. Go back to your review page and submit from there.",
          "/apply/review",
          "Back to review",
        ),
        400,
      );
    }
    if (!session.household) {
      return html(errorPage("Incomplete application", "Household information is missing. Start again.", "/apply", "Start over"), 400);
    }
    if (session.files.length === 0) {
      return redirect("/apply/documents");
    }
    household = session.household;
    reviewedDigest = fields["digest"] ?? "";
    // Promote draft bytes to filed objects before the atomic submit records them.
    const promoted: FileMeta[] = [];
    const staged: string[] = [];
    for (let i = 0; i < session.files.length; i++) {
      const draft = session.files[i]!;
      const bytes = await fileStore.get(draft.r2key);
      if (!bytes) {
        await fileStore.del(staged);
        return html(errorPage("Missing document", "An uploaded document expired before submit. Attach it again.", "/apply/documents", "Back to documents"), 400);
      }
      const r2key = submissionFileKey(scope, key, i + 1, draft.sha256);
      await fileStore.put(r2key, bytes.data, draft.type);
      staged.push(r2key);
      promoted.push({ ...draft, r2key });
    }
    files = promoted;
    uploadedKeys = staged;
  }

  const slowMs = resolveSlowMs(url, fields, config);
  const digest = await packetDigest(household, metasToDigests(files));
  if (!isJson && reviewedDigest !== digest) {
    await fileStore.del(uploadedKeys);
    return html(
      errorPage(
        "Changed since review",
        "This application changed after the review page was shown. Review the current details and submit again.",
        "/apply/review",
        "Back to review",
      ),
      400,
    );
  }
  if (source === "api") {
    // The browser may have filed this exact packet under the web scope; a retry must not file it again.
    const webFiled = await store.getSubmission(WEB_SCOPE, key);
    if (webFiled && webFiled.digest === digest) {
      await fileStore.del(uploadedKeys);
      return submissionJson(webFiled, true);
    }
  }
  let lease: string | null = null;
  if (slowMs > 0) {
    lease = await store.tryBeginSlow(nowMs(config), SLOW_LEASE_TTL_MS, config.slowMaxConcurrent);
    if (!lease) {
      await fileStore.del(uploadedKeys);
      return slowBusyResponse(!isJson && !wantsJson(request));
    }
  }
  const result = await store.submit({
    key,
    scope,
    household,
    files,
    digest,
    source,
    slowMs,
    receivedAt: nowMs(config),
  });
  if (result.outcome === "conflict") {
    // Our bytes lost; drop the objects that are not the winner's.
    const winners = new Set(result.stored.files.map((f) => f.r2key));
    await fileStore.del(uploadedKeys.filter((k) => !winners.has(k)));
    if (lease) await store.endSlow(lease);
    const stored = result.stored;
    if (isJson || wantsJson(request)) return conflictJson(stored);
    return html(
      errorPage(
        "Key already used",
        `This key already filed a different application (confirmation ${stored.confirmationNumber}). Start a new application for new details.`,
        "/apply",
        "Start a new application",
      ),
      409,
    );
  }
  // Filed objects stay (a duplicate wrote identical bytes to identical keys); drafts go.
  if (session) await fileStore.del(session.files.map((f) => f.r2key));
  const duplicate = result.outcome === "duplicate";

  if (session) await store.deleteSession(session.id);

  if (slowMs > 0 && !duplicate) await sleep(slowMs);
  if (lease) await store.endSlow(lease);

  if (isJson || wantsJson(request)) return submissionJson(result.submission, duplicate);
  return html(confirmationPage(result.submission, duplicate));
}

export interface CleanupReport {
  expiredSessions: number;
  retiredFiles: number;
  purgedReceipts: number;
}

/**
 * Scheduled cleanup. Drafts go after their timeout; submissions and their
 * files go after 7 days, leaving a small receipt for 30 days so a late
 * reconcile never sees not_found for something that was filed.
 */
export async function runCleanup(store: Store, fileStore: FileStore, now: number): Promise<CleanupReport> {
  const expired = await store.deleteExpiredSessions(now);
  await fileStore.del(expired.flatMap((s) => s.files.map((f) => f.r2key)));
  const retiredKeys = await store.retireOldSubmissions(now - SUBMISSION_RETENTION_MS);
  await fileStore.del(retiredKeys);
  await store.purgeExpiredSlowLeases(now);
  const purgedReceipts = await store.purgeOldReceipts(now - RECEIPT_RETENTION_MS);
  return { expiredSessions: expired.length, retiredFiles: retiredKeys.length, purgedReceipts };
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

  const auth = await authState(request, config);
  if (auth !== "ok") {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const allowed = await store.checkRateLimit(ip, nowMs(config), RATE_WINDOW_MS, config.rateLimitPerMinute);
    if (!allowed) return rateLimitedResponse(path);
  }
  const jsonPost = method === "POST" && path === "/submissions" && (request.headers.get("content-type") ?? "").includes("application/json");
  const isProtected =
    path === "/caseworker" || path.startsWith("/caseworker/") || (path.startsWith("/submissions") && (method === "GET" || jsonPost));
  if (isProtected && auth !== "ok") return authFailedResponse(path, auth);

  if (method === "GET" && path === "/") return html(homePage());

  if (method === "GET" && path === "/apply") return html(householdPage());

  if (method === "POST" && path === "/apply/household") {
    const capped = await readCappedBody(request, config.maxBodyBytes);
    if (!capped.ok) return tooLargeResponse(false);
    const form = await formRequestFromBytes(request, capped.bytes).formData();
    const fields: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
    }
    const parsed = validateHousehold(fields, config.maxFieldLength);
    if (!parsed.household) return html(householdPage(parsed.error, fields), 400);
    let session = await loadSession(request, store, config);
    if (!session) {
      session = {
        id: newId(),
        files: [],
        key: newId(16),
        createdAt: nowMs(config),
        expiresAt: 0,
      };
    }
    session.household = parsed.household;
    const fresh = await touchSession(store, session, config);
    return redirect("/apply/documents", sessionCookie(fresh.id));
  }

  if (method === "GET" && path === "/apply/documents") {
    const session = await loadSession(request, store, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    await touchSession(store, session, config);
    return html(documentsPage());
  }

  if (method === "POST" && path === "/apply/documents") {
    const session = await loadSession(request, store, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    const capped = await readCappedBody(request, config.maxBodyBytes);
    if (!capped.ok) return tooLargeResponse(false);
    const form = await formRequestFromBytes(request, capped.bytes).formData();
    const parsed = await readUploads(form, config, session.id, fileStore);
    if (!parsed.files) {
      await touchSession(store, session, config);
      return html(documentsPage(parsed.error), 400);
    }
    // Replacing the draft drops the previous draft objects.
    const replaced = session.files.map((f) => f.r2key).filter((k) => !parsed.files!.some((f) => f.r2key === k));
    await fileStore.del(replaced);
    session.files = parsed.files;
    await touchSession(store, session, config);
    return redirect("/apply/review");
  }

  if (method === "GET" && path === "/apply/review") {
    const session = await loadSession(request, store, config);
    if (!session) return timedOut();
    if (!session.household) return redirect("/apply");
    if (session.files.length === 0) return redirect("/apply/documents");
    await touchSession(store, session, config);
    const digest = await packetDigest(session.household, metasToDigests(session.files));
    return html(reviewPage(session.household, session.files, session.key, digest));
  }

  if (method === "POST" && path === "/submissions") {
    return handleSubmit(request, url, store, fileStore, config);
  }

  const submissionMatch = /^\/submissions\/([^/]+)$/.exec(path);
  if (method === "GET" && submissionMatch?.[1]) {
    const key = decodeURIComponent(submissionMatch[1]);
    const scope = await callerScope(request);
    const own = await store.getSubmission(scope, key);
    const sub = own ?? (await store.getSubmission(WEB_SCOPE, key));
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
    const receipt = (await store.getReceipt(scope, key)) ?? (await store.getReceipt(WEB_SCOPE, key));
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
        "content-disposition": `attachment; filename="${file.name.replaceAll('"', "")}"`,
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
