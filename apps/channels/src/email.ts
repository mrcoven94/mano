// Mano's own email inbox: offices write to a person's private address, and
// the letter reaches Mano the way a texted photo does.
//
// Address: letters+<token>@<MANO_EMAIL_DOMAIN>. The token is 130 random
// bits, minted by the person's conversation on its first turn and never
// built from a name or a number. Email Routing allows no catch-all on a
// subdomain, so one literal rule for letters@ with subaddressing on carries
// every token. A delete clears the token, which ends the address.
//
// Path: handleEmail (the Worker's email handler) checks the address, size
// and sender, parses the MIME and checks the links; the conversation stores
// the files in the person's Engine documents, texts the person, and queues a
// turn holding those documents and no words, so the agent reads them with
// Mail. Nothing from the email is ever a message from the person: the
// words become a text/plain document (AGENTS.md rule 4), the text to the
// person is fixed wording, and no link in it is ever repeated (rule 6).
// Every refusal bounces, so a sender is never left thinking it arrived.
//
// Test: pnpm --filter channels check (test/email.test.ts on the real parser,
// test-worker/email.test.ts in workerd). Needs no key and no routing.
import PostalMime, { type Email } from "postal-mime";
import {
  HANDLE_BYTES_DAILY,
  LinkChecker,
  bytesToBase64,
  createLogger,
  dayKeyFor,
  errName,
  extractLinks,
  sha256Hex,
  type Logger,
  type NormalizedEvent,
} from "@mano/channels";
import { sniffMediaType, storedForm, type DocumentStore, type PhotoConverter } from "./files.js";
import type { ConversationRunner, SpendLedger } from "./runner.js";
import type { ConversationStore } from "./store.js";
import type { Env } from "./env.js";

const EMAIL_LOCAL = "letters";
const TOKEN = /^[a-z2-7]{26}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// A 10 MB attachment, the most Engine stores, is about 13.7 MB as base64.
export const MAX_EMAIL_BYTES = 15_000_000;
const MAX_FILE_BYTES = 10_000_000;
export const MAX_EMAIL_FILES = 5;
const MAX_TEXT_CHARS = 20_000;
const MAX_HTML_CHARS = 2_000_000;
const MAX_LINKS = 25;
// Each email can cost a text and a model reading, so a leaked address
// cannot run far.
export const MAX_EMAILS_PER_DAY = 10;

export const REJECT_UNKNOWN = "Address not found.";
export const REJECT_TOO_LARGE = "Message too large. The limit is 15 MB.";
export const REJECT_SENDER = "This sender could not be verified.";
export const REJECT_EMPTY = "This message has nothing Mano can read or save.";
export const REJECT_CLOSED = "This address is not taking mail.";
export const REJECT_LATER = "Mano could not take this message right now. Please send it again later.";

export const ARRIVED_TEXT = "A letter came to your Mano email. I saved it and I am reading it now.";
export const ARRIVED_PDF_TEXT =
  "A letter came to your Mano email as a PDF. I saved it, but I cannot read PDFs yet. Send me a photo or screenshot of it and I will read that.";
export const PDF_TOO_TEXT = "It also has a PDF I saved but cannot read yet.";
export const SKIPPED_TEXT = "It had other files I could not take.";
export const LINK_TEXT = "A link in it did not pass my safety check, so do not open it.";

export function addressFor(token: string, domain: string): string {
  return `${EMAIL_LOCAL}+${token}@${domain}`;
}

export function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out += BASE32[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}

export function tokenFromAddress(to: string, domain: string): string | null {
  const [local, host, extra] = to.trim().toLowerCase().split("@");
  if (!local || extra !== undefined || host !== domain.toLowerCase()) return null;
  const [base, token, more] = local.split("+");
  return base === EMAIL_LOCAL && more === undefined && token && TOKEN.test(token) ? token : null;
}

// The conversation's own record: its token, and how many emails today.
interface InboxRow {
  token: string;
  dayKey: string;
  dayCount: number;
}

function inboxTable(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS email_inbox (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, day_key TEXT NOT NULL, day_count INTEGER NOT NULL)");
}

export function loadInbox(sql: SqlStorage): InboxRow | null {
  inboxTable(sql);
  const row = sql.exec("SELECT token, day_key, day_count FROM email_inbox WHERE id = 1").toArray()[0] as
    | { token: string; day_key: string; day_count: number }
    | undefined;
  return row ? { token: row.token, dayKey: row.day_key, dayCount: Number(row.day_count) } : null;
}

export function clearInbox(sql: SqlStorage): void {
  inboxTable(sql);
  sql.exec("DELETE FROM email_inbox");
}

// The route is written first: a token saved here always has one. Null when
// a delete landed during the write, since that token must not come back.
export async function ensureInboxToken(
  sql: SqlStorage,
  store: Pick<ConversationStore, "meta">,
  state: Pick<DurableObjectStub, "fetch">,
  handleHash: string,
): Promise<string | null> {
  const existing = loadInbox(sql);
  if (existing) return existing.token;
  const generation = store.meta().generation;
  const token = mintToken();
  const res = await state.fetch("https://state/internal/email-route", { method: "POST", body: JSON.stringify({ token, handleHash }) });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`Email route write failed: ${res.status}`);
  if (store.meta().generation !== generation) {
    await dropEmailRoute(state, token, createLogger());
    return null;
  }
  sql.exec("INSERT INTO email_inbox (id, token, day_key, day_count) VALUES (1, ?, '', 0)", token);
  return token;
}

export async function dropEmailRoute(state: Pick<DurableObjectStub, "fetch">, token: string, logger: Logger): Promise<void> {
  try {
    const res = await state.fetch(`https://state/internal/email-route?token=${token}`, { method: "DELETE" });
    await res.body?.cancel();
  } catch (err) {
    logger.warn("email_route_drop_failed", { err: errName(err) });
  }
}

// One file for the conversation to store. Base64 only on the way across
// the Durable Object boundary.
export interface EmailFile {
  mimeType: string;
  contentB64: string;
}

export interface EmailDelivery {
  handleHash: string;
  token: string;
  // SHA-256 of the raw message: a redelivery stores and queues nothing new.
  key: string;
  files: EmailFile[];
  // Files left out by type, size or count.
  skipped: number;
  linkFailed: boolean;
}

export function parseEmailDelivery(raw: unknown): EmailDelivery | null {
  const d = raw as Partial<EmailDelivery> | null;
  if (typeof d?.handleHash !== "string" || typeof d.token !== "string" || typeof d.key !== "string" || !Array.isArray(d.files)) return null;
  if (!d.files.every((f) => typeof f?.mimeType === "string" && typeof f.contentB64 === "string")) return null;
  return { handleHash: d.handleHash, token: d.token, key: d.key, files: d.files, skipped: Number(d.skipped) || 0, linkFailed: d.linkFailed === true };
}

export interface EmailAnswer {
  result: "queued" | "noted" | "duplicate" | "unknown" | "closed" | "busy" | "unavailable";
}

export interface ReceiveDeps {
  sql: SqlStorage;
  store: ConversationStore;
  runner: Pick<ConversationRunner, "handleEvent" | "sendAgentText">;
  documents: DocumentStore | null;
  photoConverter: PhotoConverter | null;
  spend: Pick<SpendLedger, "byteReserve" | "byteSettle" | "byteRelease">;
  logger: Logger;
  nowMs: () => number;
}

export function documentIdFor(generation: number, key: string, index: number): string {
  return `email-g${generation}-${key.slice(0, 24)}-${index}`;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function arrivalText(opts: { reading: boolean; pdf: boolean; skipped: boolean; linkFailed: boolean }): string {
  const parts = opts.reading ? [ARRIVED_TEXT, ...(opts.pdf ? [PDF_TOO_TEXT] : [])] : [ARRIVED_PDF_TEXT];
  if (opts.skipped) parts.push(SKIPPED_TEXT);
  if (opts.linkFailed) parts.push(LINK_TEXT);
  return parts.join(" ");
}

// Inside the person's conversation: the token must be this conversation's
// current one, so an address ends the moment a delete clears it.
export async function receiveEmail(delivery: EmailDelivery, deps: ReceiveDeps): Promise<EmailAnswer> {
  const { sql, store, runner, documents, photoConverter, spend, logger, nowMs } = deps;
  const inbox = loadInbox(sql);
  if (!inbox || inbox.token !== delivery.token) return { result: "unknown" };
  const eventId = `email:${delivery.key}`;
  if (store.hasEvent(eventId)) return { result: "duplicate" };
  const meta = store.meta();
  if (meta.optedOut || meta.closed || (!meta.chatId && !meta.to)) return { result: "closed" };
  const day = dayKeyFor(nowMs());
  const today = inbox.dayKey === day ? inbox.dayCount : 0;
  if (today >= MAX_EMAILS_PER_DAY) return { result: "busy" };
  if (!documents) return { result: "unavailable" };

  const { generation } = meta;
  const stored: { id: string; mimeType: string }[] = [];
  let skipped = delivery.skipped;
  for (const [index, file] of delivery.files.entries()) {
    const raw = base64ToBytes(file.contentB64);
    const form = file.mimeType === "text/plain" ? { bytes: raw, mimeType: file.mimeType } : await storedForm(raw, file.mimeType, photoConverter);
    const used = store.meta();
    const usedToday = used.byteDayKey === day ? used.byteDayCount : 0;
    const byteKey = `${delivery.handleHash}:${eventId}:${index}`;
    if (usedToday + form.bytes.byteLength > HANDLE_BYTES_DAILY || !(await spend.byteReserve(byteKey, form.bytes.byteLength)).allowed) {
      skipped += 1;
      continue;
    }
    const id = documentIdFor(generation, delivery.key, index);
    const saved = await documents.put({ id, name: id, bytes: form.bytes, generation }).catch((err: unknown) => {
      logger.warn("email_store_failed", { err: errName(err) });
      return false;
    });
    if (!saved) {
      await spend.byteRelease(byteKey);
      skipped += 1;
      continue;
    }
    const counted = store.meta();
    store.patchMeta({ byteDayCount: (counted.byteDayKey === day ? counted.byteDayCount : 0) + form.bytes.byteLength, byteDayKey: day });
    await spend.byteSettle(byteKey, form.bytes.byteLength).catch((err: unknown) => logger.warn("email_settle_failed", { err: errName(err) }));
    stored.push({ id, mimeType: form.mimeType });
  }
  if (stored.length === 0) return { result: "unavailable" };
  // A delete during the uploads wins; Engine refused anything after it.
  if (store.meta().generation !== generation) return { result: "unknown" };

  const reading = stored.filter((d) => d.mimeType !== "application/pdf");
  const text = arrivalText({ reading: reading.length > 0, pdf: reading.length < stored.length, skipped: skipped > 0, linkFailed: delivery.linkFailed });
  // Counted before the text, so a failure after it never lets a sender run
  // past the day's cap by retrying.
  sql.exec("UPDATE email_inbox SET day_key = ?, day_count = ? WHERE id = 1", day, today + 1);
  try {
    await runner.sendAgentText({ key: eventId, text, generation });
  } catch (err) {
    // The letter is stored, and the reading's own reply still reaches them.
    logger.warn("email_notice_failed", { err: errName(err) });
  }
  logger.info("email_received", { files: stored.length, reading: reading.length, skipped, linkFailed: delivery.linkFailed });
  // A STOP during the text must hold: an inbound here would clear it.
  const now = store.meta();
  if (reading.length === 0 || now.optedOut || now.generation !== generation) {
    store.recordEvent(eventId, "email", nowMs());
    return { result: "noted" };
  }
  const event: NormalizedEvent = {
    id: eventId,
    kind: "message.received",
    rawType: "email",
    channelId: null,
    channelType: "email",
    channelAddress: null,
    chatId: now.chatId || null,
    messageId: null,
    group: null,
    handle: now.to || null,
    direction: "inbound",
    text: null,
    attachments: reading.map((stored) => ({ url: "", stored })),
    errorCode: null,
    errorMessage: null,
    occurredAtMs: nowMs(),
  };
  const result = await runner.handleEvent(event, "webhook");
  return { result: result === "queued" ? "queued" : "noted" };
}

// What the MIME came to, before anything is stored.
export interface ParsedEmail {
  files: EmailFile[];
  skipped: number;
  links: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function htmlToText(html: string): string {
  return html
    .slice(0, MAX_HTML_CHARS)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name: string) => ENTITIES[name]!)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

// A link's address can hide behind other words in HTML, so every one is
// written out in the text and checked.
function hrefsOf(html: string): string[] {
  const out = new Set<string>();
  for (const match of html.slice(0, MAX_HTML_CHARS).matchAll(/\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) out.add(match[1]!);
  return [...out];
}

function toBytes(content: Email["attachments"][number]["content"]): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content as ArrayBuffer);
}

// Throws on a message the parser cannot read.
export async function parseEmail(raw: Uint8Array): Promise<ParsedEmail> {
  const parsed = await PostalMime.parse(raw as Uint8Array<ArrayBuffer>);
  const hrefs = hrefsOf(parsed.html ?? "");
  const body = parsed.text?.trim() || htmlToText(parsed.html ?? "");
  const hidden = hrefs.filter((href) => !body.includes(href));
  const words = [body, ...(hidden.length ? [`Links in this email:\n${hidden.join("\n")}`] : [])].join("\n\n").trim();
  const files: EmailFile[] = [];
  let skipped = 0;
  let text = "";
  if (words) {
    const head = [parsed.from?.address ? `From: ${parsed.from.address}` : "", parsed.subject ? `Subject: ${parsed.subject}` : ""].filter(Boolean).join("\n");
    text = `${head}\n\n${words}`.trim().slice(0, MAX_TEXT_CHARS);
    files.push({ mimeType: "text/plain", contentB64: bytesToBase64(new TextEncoder().encode(text)) });
  }
  for (const attachment of parsed.attachments) {
    // A logo in the signature is not a letter. An email that is only an
    // embedded scan still has its scan read.
    if (attachment.related && words) continue;
    const bytes = toBytes(attachment.content);
    // Read from the bytes' own signature, never from what the sender names.
    const mimeType = sniffMediaType(bytes);
    if (!mimeType || bytes.byteLength > MAX_FILE_BYTES || files.length >= MAX_EMAIL_FILES) {
      skipped += 1;
      continue;
    }
    files.push({ mimeType, contentB64: bytesToBase64(bytes) });
  }
  return { files, skipped, links: extractLinks(text) };
}

// True when any link is blocked, cannot be looked up (rule 6), or is one
// more than this will look up.
export async function linksFail(links: string[], checker: LinkChecker): Promise<boolean> {
  if (links.length > MAX_LINKS) return true;
  const verdicts = await Promise.all(links.map((link) => checker.checkUrl(link, true)));
  return verdicts.some((v) => !v.ok);
}

// Cloudflare prepends its own Authentication-Results; any other is the
// sender's words, so the first must be Cloudflare's. A DMARC fail means the
// domain publishes DMARC and this message did not meet it, and a fail
// anywhere in the header refuses it: a sender can only bounce itself that
// way. A result of none passes, since many county offices publish none.
export function authenticationFails(header: string | null): boolean {
  const results = header ?? "";
  return !/^\s*mx\.cloudflare\.net\b/i.test(results) || /\bdmarc=fail\b/i.test(results);
}

type SenderCheck = "ok" | "drop" | "reject";

// An automatic message or a bounce is dropped without a word, so two
// mail systems never answer each other in a loop.
export function checkSender(from: string, headers: Pick<Headers, "get">, domain: string): SenderCheck {
  const auto = headers.get("auto-submitted")?.split(";")[0]?.trim().toLowerCase();
  if (!from.trim() || from.trim() === "<>" || (auto && auto !== "no")) return "drop";
  const address = from.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.endsWith(`@${domain.toLowerCase()}`)) return "reject";
  return authenticationFails(headers.get("authentication-results")) ? "reject" : "ok";
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const DELIVERY_REJECTS: Record<EmailAnswer["result"], string | null> = {
  queued: null,
  noted: null,
  duplicate: null,
  unknown: REJECT_UNKNOWN,
  closed: REJECT_CLOSED,
  busy: REJECT_LATER,
  unavailable: REJECT_LATER,
};

export type EmailMessageIn = Pick<ForwardableEmailMessage, "from" | "to" | "headers" | "raw" | "rawSize" | "setReject">;

// The Worker's email handler. The address, size and sender are checked
// before the body is read. No address, subject or body is ever logged.
export async function handleEmail(
  message: EmailMessageIn,
  env: Env,
  state: Pick<DurableObjectStub, "fetch">,
  checker: LinkChecker = new LinkChecker(),
): Promise<void> {
  const logger = createLogger();
  const refuse = (reason: string, why: string): void => {
    logger.info("email_refused", { why });
    message.setReject(reason);
  };
  const domain = env.MANO_EMAIL_DOMAIN?.trim();
  const token = domain ? tokenFromAddress(message.to, domain) : null;
  if (!domain || !token) return refuse(REJECT_UNKNOWN, "address");
  if (message.rawSize > MAX_EMAIL_BYTES) return refuse(REJECT_TOO_LARGE, "size");
  const sender = checkSender(message.from, message.headers, domain);
  if (sender === "drop") return void logger.info("email_dropped", { why: "automatic" });
  if (sender === "reject") return refuse(REJECT_SENDER, "sender");
  try {
    const route = await state.fetch(`https://state/internal/email-route?token=${token}`);
    if (!route.ok) throw new Error(`Email route read failed: ${route.status}`);
    const { handleHash } = (await route.json()) as { handleHash: string | null };
    if (!handleHash) return refuse(REJECT_UNKNOWN, "token");
    const raw = await readCapped(message.raw, MAX_EMAIL_BYTES);
    if (!raw) return refuse(REJECT_TOO_LARGE, "size");
    let parsed: ParsedEmail;
    try {
      parsed = await parseEmail(raw);
    } catch (err) {
      logger.warn("email_unparsed", { err: errName(err) });
      return refuse(REJECT_EMPTY, "unparsed");
    }
    if (parsed.files.length === 0) return refuse(REJECT_EMPTY, "empty");
    const delivery: EmailDelivery = {
      handleHash,
      token,
      key: await sha256Hex(raw),
      files: parsed.files,
      skipped: parsed.skipped,
      linkFailed: await linksFail(parsed.links, checker),
    };
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(handleHash));
    const res = await stub.fetch("https://conversation/internal/email", { method: "POST", body: JSON.stringify(delivery) });
    if (!res.ok) throw new Error(`Conversation email failed: ${res.status}`);
    const { result } = (await res.json()) as EmailAnswer;
    const reject = DELIVERY_REJECTS[result];
    if (reject) return refuse(reject, result);
    logger.info("email_accepted", { handle: handleHash, result, bytes: raw.byteLength });
  } catch (err) {
    // A bounce, so the sender knows to try again; a redelivery is safe.
    logger.warn("email_failed", { err: errName(err) });
    message.setReject(REJECT_LATER);
  }
}
