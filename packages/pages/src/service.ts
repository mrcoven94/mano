// Framework free handlers for the site routes. Create validates the HMAC,
// validates the page against its schema, seals it and stores it. Open
// resolves a token to a live page or to gone. Unknown, expired, revoked
// and unreadable pages all read as gone, so a link never leaks whether
// a page existed. Logs carry the kind and a token hint, never page data.

import { verifyPagesRequest } from "./auth.js";
import { decryptPage, encryptPage, type SealedPage } from "./crypto.js";
import { recordOnlyForwarder, type GatewayForwarder } from "./gateway.js";
import { validatePageData, type SchemaError } from "./schema.js";
import { idempotencyObjectKey, pageObjectKey, type PageStore } from "./store.js";
import { showPageText } from "./tool.js";
import { isToken, mintToken, PAGE_TTL_MS, sha256Hex, tokenStorageId } from "./tokens.js";
import type { StoredPage } from "./types.js";

export interface PagesSecrets {
  hmacSecret: string;
  kekB64: string | null;
  allowInsecure: boolean;
}

export interface PagesDeps {
  store: PageStore;
  secrets: PagesSecrets;
  baseUrl: string;
  nowMs: () => number;
  mint?: () => string;
  forwardApproval?: GatewayForwarder;
  verifyOtp?: (code: string) => Promise<boolean>;
  log?: (line: string) => void;
}

export type CreateOut =
  | { status: 201; url: string; token: string; text: string; reused: boolean }
  | { status: 400; error: string; errors?: SchemaError[] }
  | { status: 401; error: string }
  | { status: 503; error: string };

export type ResolvedPage = { state: "live"; page: StoredPage } | { state: "gone" };

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function say(deps: PagesDeps, line: string): void {
  deps.log?.(line);
}

function tokenHint(token: string): string {
  return token.slice(0, 6);
}

interface StoredEnvelope {
  sealed?: SealedPage;
  plain?: string;
}

async function sealStored(page: StoredPage, storageId: string, deps: PagesDeps): Promise<Uint8Array> {
  const json = JSON.stringify(page);
  const kek = deps.secrets.kekB64;
  if (kek) {
    const sealed = await encryptPage(new TextEncoder().encode(json), kek, storageId);
    return new TextEncoder().encode(JSON.stringify({ sealed } satisfies StoredEnvelope));
  }
  if (!deps.secrets.allowInsecure) throw new Error("pages KEK is missing");
  say(deps, "pages store kind=? result=insecure token=? note=storing pages without encryption (local only)");
  return new TextEncoder().encode(JSON.stringify({ plain: json } satisfies StoredEnvelope));
}

async function openStored(
  raw: Uint8Array,
  storageId: string,
  deps: PagesDeps,
): Promise<StoredPage | null> {
  let envelope: StoredEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(raw)) as StoredEnvelope;
  } catch {
    return null;
  }
  try {
    if (envelope.sealed) {
      const kek = deps.secrets.kekB64;
      if (!kek) return null;
      const open = await decryptPage(envelope.sealed, kek, storageId);
      return JSON.parse(new TextDecoder().decode(open)) as StoredPage;
    }
    if (typeof envelope.plain === "string" && deps.secrets.allowInsecure) {
      return JSON.parse(envelope.plain) as StoredPage;
    }
    return null;
  } catch {
    return null;
  }
}

interface IdemRecord {
  v: 1;
  storageId: string;
  url: string;
  text: string;
}

async function readIdem(clientKey: string, deps: PagesDeps): Promise<IdemRecord | null> {
  const hash = await sha256Hex(`mano-page-idem:v1:${clientKey}`);
  const raw = await deps.store.get(idempotencyObjectKey(hash));
  if (!raw) return null;
  try {
    const rec = JSON.parse(new TextDecoder().decode(raw)) as IdemRecord;
    if (rec.v !== 1 || typeof rec.url !== "string" || typeof rec.text !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

function looksStored(value: unknown): value is StoredPage {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return rec.v === 1 && typeof rec.expiresAtMs === "number" && typeof rec.page === "object" && rec.page !== null;
}

export async function handleCreate(
  rawBody: string,
  signature: string | null,
  idempotencyKey: string | null,
  deps: PagesDeps,
): Promise<CreateOut> {
  const nowMs = deps.nowMs();
  if (!deps.secrets.hmacSecret) {
    say(deps, "pages create result=unconfigured");
    return { status: 503, error: "page links are not set up yet" };
  }
  const auth = await verifyPagesRequest(rawBody, signature, deps.secrets.hmacSecret, Math.floor(nowMs / 1000));
  if (!auth.ok) {
    say(deps, `pages create result=denied reason=${auth.failure ?? "unknown"}`);
    return { status: 401, error: "bad signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, error: "body must be json" };
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { status: 400, error: "idempotency key looks wrong" };
  }
  if (idempotencyKey) {
    const prior = await readIdem(idempotencyKey, deps);
    if (prior) {
      say(deps, "pages create result=reused");
      const match = /\/p\/([A-Za-z0-9_-]{22})$/.exec(prior.url);
      return { status: 201, url: prior.url, token: match ? match[1] : "", text: prior.text, reused: true };
    }
  }
  const checked = validatePageData(body.kind, body.data);
  if (!checked.ok) {
    say(deps, `pages create result=invalid kind=${typeof body.kind === "string" ? body.kind : "?"}`);
    return { status: 400, error: "page data failed its schema", errors: checked.errors };
  }
  if (!deps.secrets.kekB64 && !deps.secrets.allowInsecure) {
    say(deps, `pages create kind=${checked.data.kind} result=no_kek`);
    return { status: 503, error: "page storage is not set up yet" };
  }
  const mint = deps.mint ?? mintToken;
  const token = mint();
  const storageId = await tokenStorageId(token);
  const page: StoredPage = {
    v: 1,
    page: checked.data,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + PAGE_TTL_MS,
    revokedAtMs: null,
    clientKey: idempotencyKey,
  };
  const url = `${deps.baseUrl}/p/${token}`;
  const text = showPageText(checked.data, url);
  await deps.store.put(pageObjectKey(storageId), await sealStored(page, storageId, deps));
  if (idempotencyKey) {
    const hash = await sha256Hex(`mano-page-idem:v1:${idempotencyKey}`);
    const rec: IdemRecord = { v: 1, storageId, url, text };
    await deps.store.put(idempotencyObjectKey(hash), new TextEncoder().encode(JSON.stringify(rec)));
  }
  say(deps, `pages create kind=${checked.data.kind} result=created token=${tokenHint(token)}`);
  return { status: 201, url, token, text, reused: false };
}

export async function resolvePage(token: unknown, deps: PagesDeps): Promise<ResolvedPage> {
  if (!isToken(token)) return { state: "gone" };
  const storageId = await tokenStorageId(token);
  const raw = await deps.store.get(pageObjectKey(storageId));
  if (!raw) return { state: "gone" };
  const page = await openStored(raw, storageId, deps);
  if (!looksStored(page)) return { state: "gone" };
  if (page.revokedAtMs !== null || page.expiresAtMs <= deps.nowMs()) return { state: "gone" };
  return { state: "live", page };
}

export type ActionOut =
  | { status: 200; page: StoredPage; approval?: { forwarded: boolean; reason: string } }
  | { status: 200; needCode: true }
  | { status: 400; error: string }
  | { status: 404; error: string }
  | { status: 410; error: string }
  | { status: 501; error: string }
  | { status: 503; error: string };

export const GONE_WORDS = "this page has expired";

async function saveLive(storageId: string, page: StoredPage, deps: PagesDeps): Promise<void> {
  await deps.store.put(pageObjectKey(storageId), await sealStored(page, storageId, deps));
}

async function loadLive(
  token: string,
  deps: PagesDeps,
): Promise<{ page: StoredPage; storageId: string } | { gone: true; status: 404 | 410 }> {
  const storageId = await tokenStorageId(token);
  const raw = await deps.store.get(pageObjectKey(storageId));
  if (!raw) return { gone: true, status: 404 };
  const page = await openStored(raw, storageId, deps);
  if (!looksStored(page)) return { gone: true, status: 404 };
  if (page.revokedAtMs !== null || page.expiresAtMs <= deps.nowMs()) return { gone: true, status: 410 };
  return { page, storageId };
}

async function proposalHashFor(page: StoredPage): Promise<string> {
  if (page.page.kind !== "approve") return "";
  const { action, forWhom, destination, sends, note } = page.page;
  return sha256Hex(JSON.stringify({ action, destination, forWhom, note: note ?? null, sends }));
}

export async function handleAction(token: unknown, rawBody: string, deps: PagesDeps): Promise<ActionOut> {
  if (!isToken(token)) return { status: 404, error: GONE_WORDS };
  const loaded = await loadLive(token, deps);
  if ("gone" in loaded) return { status: loaded.status, error: GONE_WORDS };
  const { page, storageId } = loaded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, error: "body must be json" };
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (body.op === "revoke") {
    page.revokedAtMs = deps.nowMs();
    await saveLive(storageId, page, deps);
    say(deps, `pages action op=revoke result=revoked token=${tokenHint(token)}`);
    return { status: 200, page };
  }
  if (body.op === "check") {
    if (page.page.kind !== "checklist") return { status: 400, error: "this page has nothing to check" };
    if (typeof body.id !== "string" || typeof body.checked !== "boolean") {
      return { status: 400, error: "name an item and its new state" };
    }
    const item = page.page.items.find((i) => i.id === body.id);
    if (!item) return { status: 400, error: "that item is not on this page" };
    item.checked = body.checked;
    await saveLive(storageId, page, deps);
    say(deps, `pages action op=check result=saved token=${tokenHint(token)}`);
    return { status: 200, page };
  }
  if (body.op === "edit") {
    if (page.page.kind !== "review") return { status: 400, error: "this page has nothing to edit" };
    const values = body.values;
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return { status: 400, error: "send new values by field" };
    }
    for (const [id, value] of Object.entries(values as Record<string, unknown>)) {
      const field = page.page.kind === "review" ? page.page.fields.find((f) => f.id === id) : undefined;
      if (!field) return { status: 400, error: "that field is not on this page" };
      if (typeof value !== "string" || value.length > 2000) {
        return { status: 400, error: "keep each field under 2000 characters" };
      }
      field.value = value;
    }
    await saveLive(storageId, page, deps);
    say(deps, `pages action op=edit result=saved token=${tokenHint(token)}`);
    return { status: 200, page };
  }
  if (body.op === "decide") {
    if (page.page.kind !== "approve") return { status: 400, error: "this page asks nothing" };
    if (body.choice !== "approved" && body.choice !== "declined") {
      return { status: 400, error: "answer approved or declined" };
    }
    if (page.page.decision) return { status: 400, error: "this page was already answered" };
    if (page.page.otpRequired) {
      if (!deps.verifyOtp) return { status: 501, error: "one time codes are not on yet" };
      if (typeof body.code !== "string" || body.code === "") return { status: 200, needCode: true };
      const good = await deps.verifyOtp(body.code);
      if (!good) return { status: 400, error: "that code did not match" };
    }
    const proposalHash = await proposalHashFor(page);
    page.page.decision = { choice: body.choice, atMs: deps.nowMs(), proposalHash };
    await saveLive(storageId, page, deps);
    const forward = deps.forwardApproval ?? recordOnlyForwarder;
    const approval = await forward.forwardApproval({ pageId: storageId, proposalHash, choice: body.choice, atMs: page.page.decision.atMs });
    say(deps, `pages action op=decide result=${body.choice} forwarded=${approval.forwarded} token=${tokenHint(token)}`);
    return { status: 200, page, approval };
  }
  return { status: 400, error: "unknown action" };
}

export type AgentRevokeOut = { status: 200 } | { status: 400; error: string } | { status: 401; error: string } | { status: 404; error: string };

export async function handleAgentRevoke(
  rawBody: string,
  signature: string | null,
  deps: PagesDeps,
): Promise<AgentRevokeOut> {
  if (!deps.secrets.hmacSecret) return { status: 401, error: "bad signature" };
  const auth = await verifyPagesRequest(rawBody, signature, deps.secrets.hmacSecret, Math.floor(deps.nowMs() / 1000));
  if (!auth.ok) {
    say(deps, `pages revoke result=denied reason=${auth.failure ?? "unknown"}`);
    return { status: 401, error: "bad signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, error: "body must be json" };
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (!isToken(body.token)) return { status: 404, error: GONE_WORDS };
  const loaded = await loadLive(body.token, deps);
  if ("gone" in loaded) return { status: 404, error: GONE_WORDS };
  loaded.page.revokedAtMs = deps.nowMs();
  await saveLive(loaded.storageId, loaded.page, deps);
  say(deps, `pages revoke result=revoked token=${tokenHint(body.token)}`);
  return { status: 200 };
}
