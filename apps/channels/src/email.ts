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
// and sender, parses the MIME and the HTML (postal-mime, htmlparser2) and
// checks the links; the conversation stores
// the files in the person's Engine documents, texts the person, and queues a
// turn holding those documents and no words, so the agent reads them with
// Mail. Nothing from the email is ever a message from the person: the
// words become a text/plain document (AGENTS.md rule 4), the text to the
// person is fixed wording, and no link in it is ever repeated (rule 6).
// Every refusal bounces, so a sender is never left thinking it arrived.
//
// Test: pnpm --filter channels check (test/email.test.ts on the real parser,
// test-worker/email.test.ts in workerd). Needs no key and no routing.
import { Parser } from "htmlparser2";
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
const MAX_SUBJECT_CHARS = 300;
// Below this an embedded image is taken for a logo. A page scanned so it
// can be read is larger.
const MIN_EMBEDDED_SCAN_BYTES = 30_000;
const MAX_LINKS = 25;
// How much of a message's HTML and plain text is read at all, out of the
// 15 MB a message can be. Past either limit the letter counts as cut and
// its links as failed, since nothing vouches for what was not read.
const MAX_SCAN_CHARS = 2_000_000;
// Each close tag costs the parser a walk of its open tags, so a message's
// tags are counted before it parses any. Far more than a real letter holds.
const MAX_HTML_TAGS = 20_000;
// Mail reads this type as text it must not hold a date from.
const TRUNCATED_MARK = "; truncated=yes";
// Each email can cost a text and a model reading, so a leaked address
// cannot run far.
export const MAX_EMAILS_PER_DAY = 10;
// An arrival text that did not go is tried again after a minute, doubling
// to an hour, for about a day. A person's own texts are not held up by it.
const NOTICE_RETRY_MS = 60_000;
const NOTICE_RETRY_MAX_MS = 3_600_000;
const NOTICE_MAX_ATTEMPTS = 30;

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
export const TRUNCATED_TEXT = "I could not read all of it, so I will not save a date from it. Ask the office for the dates.";
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

function inboxTable(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS email_inbox (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)");
  // The one count of email: a row is a day's slot and its bytes, for one
  // message in one conversation generation. A redelivery finds its own row
  // and adds nothing, a crash leaves a row the redelivery reuses, and a row
  // from before a delete is never counted or touched.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS email_messages (message_key TEXT NOT NULL, generation INTEGER NOT NULL, day_key TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (message_key, generation))",
  );
  // Arrival texts that have not gone yet. The epoch moves on a STOP, a close
  // or a delete, which ends what is owed even if the person comes back.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS email_owed (key TEXT PRIMARY KEY, text TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, attempts INTEGER NOT NULL, next_at_ms INTEGER NOT NULL)",
  );
}

export function emailBytesToday(sql: SqlStorage, generation: number, day: string): number {
  inboxTable(sql);
  const row = sql.exec("SELECT COALESCE(SUM(bytes), 0) AS used FROM email_messages WHERE generation = ? AND day_key = ?", generation, day).toArray()[0] as { used: number };
  return Number(row.used);
}

function emailsToday(sql: SqlStorage, generation: number, day: string): number {
  return sql.exec("SELECT message_key FROM email_messages WHERE generation = ? AND day_key = ?", generation, day).toArray().length;
}

export function loadInbox(sql: SqlStorage): { token: string } | null {
  inboxTable(sql);
  const row = sql.exec("SELECT token FROM email_inbox WHERE id = 1").toArray()[0] as { token: string } | undefined;
  return row ? { token: row.token } : null;
}

export function clearInbox(sql: SqlStorage): void {
  inboxTable(sql);
  sql.exec("DELETE FROM email_inbox");
  sql.exec("DELETE FROM email_messages");
  sql.exec("DELETE FROM email_owed");
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
  sql.exec("INSERT INTO email_inbox (id, token) VALUES (1, ?)", token);
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
  truncated: boolean;
  linkFailed: boolean;
}

export function parseEmailDelivery(raw: unknown): EmailDelivery | null {
  const d = raw as Partial<EmailDelivery> | null;
  if (typeof d?.handleHash !== "string" || typeof d.token !== "string" || typeof d.key !== "string" || !Array.isArray(d.files)) return null;
  if (!d.files.every((f) => typeof f?.mimeType === "string" && typeof f.contentB64 === "string")) return null;
  return { handleHash: d.handleHash, token: d.token, key: d.key, files: d.files, skipped: Number(d.skipped) || 0, truncated: d.truncated === true, linkFailed: d.linkFailed === true };
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

export function arrivalText(opts: { reading: boolean; pdf: boolean; skipped: boolean; cut: boolean; linkFailed: boolean }): string {
  const parts = opts.reading ? [ARRIVED_TEXT, ...(opts.pdf ? [PDF_TOO_TEXT] : [])] : [ARRIVED_PDF_TEXT];
  if (opts.skipped) parts.push(SKIPPED_TEXT);
  if (opts.cut && opts.reading) parts.push(TRUNCATED_TEXT);
  if (opts.linkFailed) parts.push(LINK_TEXT);
  return parts.join(" ");
}

// Inside the person's conversation: the token must be this conversation's
// current one, so an address ends the moment a delete clears it. An email is
// stored whole or bounced, and copies of one message run the same steps, each
// of which is safe to repeat.
export async function receiveEmail(delivery: EmailDelivery, deps: ReceiveDeps): Promise<EmailAnswer> {
  const { sql, store, documents, photoConverter, spend, nowMs } = deps;
  const eventId = `email:${delivery.key}`;
  const refused = (): EmailAnswer | null => {
    if (loadInbox(sql)?.token !== delivery.token) return { result: "unknown" };
    if (store.hasEvent(eventId)) return { result: "duplicate" };
    const meta = store.meta();
    return meta.optedOut || meta.closed || (!meta.chatId && !meta.to) ? { result: "closed" } : null;
  };
  const early = refused();
  if (early) return early;
  if (!documents) return { result: "unavailable" };
  // A converted photo is what gets stored, so that is the size that counts.
  const forms: { bytes: Uint8Array; mimeType: string }[] = [];
  for (const file of delivery.files) {
    const raw = base64ToBytes(file.contentB64);
    forms.push(file.mimeType === "text/plain" ? { bytes: raw, mimeType: file.mimeType } : await storedForm(raw, file.mimeType, photoConverter));
  }
  const late = refused();
  if (late) return late;

  // From here to the insert there is no await, so mail arriving at once
  // cannot all see the same room.
  const meta = store.meta();
  const { generation } = meta;
  const day = dayKeyFor(nowMs());
  const size = forms.reduce((sum, form) => sum + form.bytes.byteLength, 0);
  const own = () => sql.exec("SELECT state FROM email_messages WHERE message_key = ? AND generation = ?", delivery.key, generation).toArray()[0] as { state: string } | undefined;
  if (!own()) {
    const photos = meta.byteDayKey === day ? meta.byteDayCount : 0;
    if (emailsToday(sql, generation, day) >= MAX_EMAILS_PER_DAY || photos + emailBytesToday(sql, generation, day) + size > HANDLE_BYTES_DAILY) return { result: "busy" };
    sql.exec("DELETE FROM email_messages WHERE day_key != ? OR generation != ?", day, generation);
    sql.exec("INSERT INTO email_messages (message_key, generation, day_key, bytes, state) VALUES (?, ?, ?, ?, 'claimed')", delivery.key, generation, day, size);
  }
  const byteKey = `${delivery.handleHash}:${eventId}`;
  // Only a row still claimed comes back: stored files are really there, and
  // the row of another generation is not this one's to touch.
  const release = async (): Promise<void> => {
    if (own()?.state === "claimed") sql.exec("DELETE FROM email_messages WHERE message_key = ? AND generation = ?", delivery.key, generation);
    await spend.byteRelease(byteKey).catch((err: unknown) => deps.logger.warn("email_release_failed", { err: errName(err) }));
  };
  try {
    if (!(await spend.byteReserve(byteKey, size)).allowed) {
      await release();
      return { result: "busy" };
    }
    const answer = await storeAndQueue(delivery, forms, documents, generation, day, size, eventId, deps);
    if (answer.result === "unavailable" || answer.result === "closed" || answer.result === "unknown") await release();
    return answer;
  } catch (err) {
    await release();
    throw err;
  }
}

export interface OwedNotice {
  key: string;
  text: string;
  generation: number;
}

// When an arrival text is tried again after this many tries.
function noticeBackoffMs(attempts: number): number {
  return Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

export function owe(sql: SqlStorage, notice: OwedNotice, epoch: number, nextAtMs: number): void {
  inboxTable(sql);
  sql.exec(
    "INSERT OR REPLACE INTO email_owed (key, text, generation, epoch, attempts, next_at_ms) VALUES (?, ?, ?, ?, 1, ?)",
    notice.key,
    notice.text,
    notice.generation,
    epoch,
    nextAtMs,
  );
}

export function owedCount(sql: SqlStorage): number {
  inboxTable(sql);
  return sql.exec("SELECT key FROM email_owed").toArray().length;
}

export function nextOwedAt(sql: SqlStorage): number | null {
  inboxTable(sql);
  const row = sql.exec("SELECT next_at_ms FROM email_owed ORDER BY next_at_ms LIMIT 1").toArray()[0] as { next_at_ms: number } | undefined;
  return row ? Number(row.next_at_ms) : null;
}

type NoticeSender = Pick<ConversationRunner, "sendAgentText">;

// True when the text went or never can: a delete, STOP, a close or a definite
// refusal ends it. A throw or today's budget leaves it for another try.
async function sendNotice(runner: NoticeSender, notice: OwedNotice, logger: Logger): Promise<boolean> {
  try {
    return (await runner.sendAgentText(notice)).reason !== "budget";
  } catch (err) {
    logger.warn("email_notice_failed", { err: errName(err) });
    return false;
  }
}

// One owed text whose time has come. The caller holds it back while the
// person has input waiting.
export async function sendOneOwedNotice(
  sql: SqlStorage,
  store: Pick<ConversationStore, "meta">,
  runner: NoticeSender,
  logger: Logger,
  nowMs: () => number,
): Promise<void> {
  inboxTable(sql);
  const row = sql.exec("SELECT key, text, generation, epoch, attempts FROM email_owed WHERE next_at_ms <= ? ORDER BY next_at_ms LIMIT 1", nowMs()).toArray()[0] as
    | { key: string; text: string; generation: number; epoch: number; attempts: number }
    | undefined;
  if (!row) return;
  const drop = () => sql.exec("DELETE FROM email_owed WHERE key = ?", row.key);
  if (Number(row.epoch) !== store.meta().decorationEpoch) return void drop();
  if (await sendNotice(runner, { key: row.key, text: row.text, generation: Number(row.generation) }, logger)) return void drop();
  const attempts = Number(row.attempts) + 1;
  if (attempts >= NOTICE_MAX_ATTEMPTS) {
    logger.warn("email_notice_abandoned", { attempts });
    return void drop();
  }
  sql.exec("UPDATE email_owed SET attempts = ?, next_at_ms = ? WHERE key = ?", attempts, nowMs() + noticeBackoffMs(attempts), row.key);
}

async function storeAndQueue(
  delivery: EmailDelivery,
  forms: { bytes: Uint8Array; mimeType: string }[],
  documents: DocumentStore,
  generation: number,
  day: string,
  size: number,
  eventId: string,
  deps: ReceiveDeps,
): Promise<EmailAnswer> {
  const { sql, store, runner, spend, logger, nowMs } = deps;
  const stored: { id: string; mimeType: string }[] = [];
  for (const [index, form] of forms.entries()) {
    const id = documentIdFor(generation, delivery.key, index);
    const saved = await documents.put({ id, name: id, bytes: form.bytes, generation }).catch((err: unknown) => {
      logger.warn("email_store_failed", { err: errName(err) });
      return false;
    });
    // A store that failed may work next time, so the sender is asked to send
    // it again rather than losing a part.
    if (!saved) return { result: "unavailable" };
    stored.push({ id, mimeType: form.mimeType });
  }
  // A delete during the uploads wins; Engine refused anything after it.
  const uploaded = store.meta();
  if (uploaded.generation !== generation) return { result: "unknown" };
  sql.exec("INSERT OR REPLACE INTO email_messages (message_key, generation, day_key, bytes, state) VALUES (?, ?, ?, ?, 'stored')", delivery.key, generation, day, size);
  await spend.byteSettle(`${delivery.handleHash}:${eventId}`, size).catch((err: unknown) => logger.warn("email_settle_failed", { err: errName(err) }));
  // So does a STOP or a close. Nobody will be told, so the sender must be.
  const settled = store.meta();
  if (settled.generation !== generation) return { result: "unknown" };
  if (settled.optedOut || settled.closed) return { result: "closed" };

  const reading = stored.filter((d) => d.mimeType !== "application/pdf");
  const pdf = reading.length < stored.length;
  const skipped = delivery.skipped > 0;
  // Any part not read could change what the read parts say, so none of them
  // can hold a date.
  const cut = delivery.truncated || skipped || pdf;
  const text = arrivalText({ reading: reading.length > 0, pdf, skipped, cut, linkFailed: delivery.linkFailed });
  // Owed until it goes: it can be the only word of a PDF or a bad link.
  const notice = { key: eventId, text, generation };
  if (!(await sendNotice(runner, notice, logger))) owe(sql, notice, settled.decorationEpoch, nowMs() + NOTICE_RETRY_MS);
  logger.info("email_received", { files: stored.length, reading: reading.length, skipped: delivery.skipped, cut, linkFailed: delivery.linkFailed });
  // Read once more after that await, with none until handleEvent has
  // written: an inbound clears both STOP and a close.
  const now = store.meta();
  if (reading.length === 0 || now.optedOut || now.closed || now.generation !== generation) {
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
    attachments: reading.map((d) => ({ url: "", stored: { id: d.id, mimeType: cut ? `${d.mimeType}${TRUNCATED_MARK}` : d.mimeType } })),
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
  // The words were cut to fit, so what is missing could change what is kept.
  truncated: boolean;
  links: string[];
  // Some of the message was never read, so its links cannot be vouched for.
  linksUnread: boolean;
}

// Places an attribute can point that are not a web page.
const HARMLESS_SCHEME = /^(?:mailto|tel|sms|cid):/i;
const LINK_ATTRIBUTES = ["href", "xlink:href", "action", "formaction"];
const UNSEEN_TAGS = new Set(["script", "style"]);
const BLOCK_TAGS = new Set(["br", "p", "div", "table", "tr", "td", "th", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote", "pre", "ul", "ol"]);

// One attribute's value, entities already decoded by the parser, as a browser
// would resolve it. Null for what is not a link out of the email. Any other
// scheme is kept: the link check fails it.
export function linkFromAttribute(value: string): string | null {
  const url = value
    .replace(/[\t\n\r]/g, "")
    .trim()
    .replace(/\\/g, "/");
  if (!url || url.startsWith("#") || HARMLESS_SCHEME.test(url)) return null;
  if (url.startsWith("//")) return `https:${url}`;
  const web = /^(https?):\/*(.*)$/is.exec(url);
  if (web) return `${web[1]!.toLowerCase()}://${web[2]}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return extractLinks(url).length > 0 ? url : null;
}

// What a person would see, and every link attribute, as a browser would
// parse them, up to the tag limit. complete is false when that left some out.
export function readHtml(html: string): { text: string; hrefs: string[]; complete: boolean } {
  let at = -1;
  for (let tags = 0; tags <= MAX_HTML_TAGS; tags++) {
    at = html.indexOf("<", at + 1);
    if (at < 0) break;
  }
  const complete = at < 0;
  const parts: string[] = [];
  const hrefs = new Set<string>();
  let unseen = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (UNSEEN_TAGS.has(name)) unseen += 1;
        if (BLOCK_TAGS.has(name)) parts.push("\n");
        for (const attribute of LINK_ATTRIBUTES) {
          const value = attributes[attribute];
          const link = value === undefined ? null : linkFromAttribute(value);
          // One past the most that gets checked already fails the check.
          if (link && hrefs.size <= MAX_LINKS) hrefs.add(link);
        }
      },
      ontext(text) {
        if (unseen === 0) parts.push(text);
      },
      onclosetag(name) {
        if (UNSEEN_TAGS.has(name)) unseen = Math.max(0, unseen - 1);
        if (BLOCK_TAGS.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(complete ? html : html.slice(0, at));
  parser.end();
  const text = parts
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
  return { text, hrefs: [...hrefs], complete };
}

// Case and spacing only: a sign or a symbol can be the whole difference.
const comparable = (sentence: string): string => sentence.toLowerCase();
const sentencesOf = (text: string): string[] => text.replace(/\s+/g, " ").split(/(?<=[.!?]) /).filter((s) => /[\p{L}\p{N}]/u.test(s));

// The sentences of the HTML part that the plain part does not have. A plain
// part is often a stale or shorter copy, and a correction may be only in the
// HTML, so nothing the office wrote is dropped for being in one part alone.
export function htmlOnlySentences(plain: string, htmlText: string): string[] {
  const inPlain = new Set(sentencesOf(plain).map(comparable));
  return sentencesOf(htmlText).filter((s) => !inPlain.has(comparable(s)));
}

function toBytes(content: Email["attachments"][number]["content"]): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content as ArrayBuffer);
}

// Throws on a message the parser cannot read.
export async function parseEmail(raw: Uint8Array): Promise<ParsedEmail> {
  const parsed = await PostalMime.parse(raw as Uint8Array<ArrayBuffer>);
  const fullHtml = parsed.html ?? "";
  const fullPlain = parsed.text?.trim() ?? "";
  const html = readHtml(fullHtml.slice(0, MAX_SCAN_CHARS));
  const plain = fullPlain.slice(0, MAX_SCAN_CHARS);
  const fullyRead = html.complete && fullHtml.length <= MAX_SCAN_CHARS && fullPlain.length <= MAX_SCAN_CHARS;
  const htmlOnly = plain ? htmlOnlySentences(plain, html.text) : [];
  const body = plain ? [plain, ...(htmlOnly.length ? [`The HTML version of this email also says:\n${htmlOnly.join("\n")}`] : [])].join("\n\n") : html.text;
  const hidden = html.hrefs.filter((href) => !body.includes(href));
  const words = [body, ...(hidden.length ? [`Links in this email:\n${hidden.join("\n")}`] : [])].join("\n\n").trim();
  // Every link counts, cut or not.
  const subject = parsed.subject ?? "";
  const links = new Set([...extractLinks(subject), ...extractLinks(words), ...html.hrefs]);
  const files: EmailFile[] = [];
  let skipped = 0;
  // Cut whether or not any words survived, so an attachment is marked too.
  let truncated = !fullyRead || subject.length > MAX_SUBJECT_CHARS;
  if (words) {
    const head = [parsed.from?.address ? `From: ${parsed.from.address}` : "", subject ? `Subject: ${subject.slice(0, MAX_SUBJECT_CHARS)}` : ""].filter(Boolean).join("\n");
    const whole = `${head}\n\n${words}`.trim();
    truncated ||= whole.length > MAX_TEXT_CHARS;
    files.push({ mimeType: "text/plain", contentB64: bytesToBase64(new TextEncoder().encode(whole.slice(0, MAX_TEXT_CHARS))) });
  }
  // Attached files come first, so an embedded image never takes their place.
  const attachments = [...parsed.attachments.filter((a) => !a.related), ...parsed.attachments.filter((a) => a.related)];
  for (const attachment of attachments) {
    const bytes = toBytes(attachment.content);
    // Read from the bytes' own signature, never from what the sender names.
    const mimeType = sniffMediaType(bytes);
    // A logo in the signature is not a letter, and is not worth a word to
    // the person. A scan embedded beside the words is both.
    if (attachment.related && words && mimeType !== "application/pdf" && bytes.byteLength < MIN_EMBEDDED_SCAN_BYTES) continue;
    if (!mimeType || bytes.byteLength > MAX_FILE_BYTES || files.length >= MAX_EMAIL_FILES) {
      skipped += 1;
      continue;
    }
    files.push({ mimeType, contentB64: bytesToBase64(bytes) });
  }
  return { files, skipped, truncated, links: [...links], linksUnread: !fullyRead };
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
      truncated: parsed.truncated,
      linkFailed: parsed.linksUnread || (await linksFail(parsed.links, checker)),
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
