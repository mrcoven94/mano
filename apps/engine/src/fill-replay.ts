// A fill's replay: the screens Mano's computer showed while it filled a
// form, kept for the approval that fill produced, so the person can see
// each step before they say yes.
//
// One row per approval, written once: the first bind wins and a retry
// gets the same link. The row holds the approval's request hash at bind
// time, the form's labels, each step's caption and where its image lives,
// and the link token. Images are stored the way documents are
// (src/files.ts): encrypted for the person, bound to the person and an
// ID, in R2 under the conversation generation, so a conversation delete
// sweeps them with the documents.
//
// The link is a random 128-bit token in hex, which the text line's voice
// guard leaves whole. Only the person's own thread carries it. R2 keeps
// the token's hash, never the token, pointing at the person and the
// approval until the link expires.
//
// Every view asks the approval again. Only a version a YES would still
// send exactly, or the one the person already said yes to, shows its
// steps; a draft that changed or was replaced says so and shows none.
import { currentGeneration } from "./agents/agent-state.js";
import type { Approval } from "./gateway/types.js";
import { CURRENT_GENERATION } from "./gateway/sql-store.js";
import { base64ToBytes, bytesToBase64, sha256Hex, timingSafeEqual } from "./hash.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

export const MAX_REPLAY_STEPS = 24;
export const MAX_STEP_BYTES = 2_000_000;
export const MAX_REPLAY_BYTES = 10_000_000;
export const REPLAY_LINK_TTL_MS = 7 * 24 * 3600_000;
export const REPLAY_LINK_PATH = /^\/fill\/([0-9a-f]{32})$/;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const LABEL_KEY = /^[A-Za-z0-9_]{1,64}$/;
const MAX_LABELS = 50;
const MAX_TEXT = 200;

// A place on a screenshot, in its pixels: where Mano clicked before it
// typed, so the page can show that field up close.
export interface Point {
  x: number;
  y: number;
}

export interface ReplayInput {
  // Field name to the label the form shows, in the form's order.
  labels: Record<string, string>;
  steps: { caption: string; png: Uint8Array; focus: Point | null }[];
}

// One stored step: its caption, where its image lives, and the image's
// size from its PNG header, which the close-up view is computed from.
export interface StoredStep {
  caption: string;
  hash: string;
  r2Key: string;
  width: number;
  height: number;
  focus: Point | null;
}

export interface StoredReplay {
  approvalId: string;
  requestHash: string;
  generation: number;
  labels: Record<string, string>;
  steps: StoredStep[];
  linkToken: string;
  linkExpiresAtMs: number;
}

// Where a link points: kept in R2 under the token's hash.
export interface ReplayLinkEntry {
  personId: string;
  approvalId: string;
  expiresAtMs: number;
}

// The person's image and link storage. In Engine both are R2.
export interface ReplayStorage {
  putImage(imageId: string, png: Uint8Array, generation: number): Promise<{ hash: string; r2Key: string }>;
  getImage(imageId: string, r2Key: string): Promise<Uint8Array | null>;
  deleteObjects(keys: string[]): Promise<void>;
  putLink(key: string, entry: ReplayLinkEntry): Promise<void>;
}

export interface ReplayApprovals {
  getApproval(id: string): Approval | null;
  approvalCurrent(id: string): boolean;
  proposalCurrent(id: string): boolean;
}

export type BindOutcome =
  | { status: "created" | "existing"; token: string }
  // No approval by this ID for this person.
  | { status: "not_found" }
  // The approval no longer waits for a yes.
  | { status: "closed" }
  // Prepared under a conversation generation a delete has moved past.
  | { status: "stale" };

// What the page says about the version it was made for.
//   current: a YES now sends exactly this.
//   approved: the person said yes to this version.
//   changed: the draft changed or a newer one replaced it; no steps shown.
//   closed: declined, expired or removed; no steps shown.
export type ReplayState = "current" | "approved" | "changed" | "closed";

export class ReplayInputError extends Error {
  override name = "ReplayInputError";
}

// fill_link_cleanup holds the R2 keys of link entries whose replays a
// conversation delete removed, until R2 confirms they are gone, so a
// delete that fails halfway finishes on its retry.
export function ensureFillReplayTables(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS fill_replays(
    approval_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, generation INTEGER NOT NULL,
    labels_json TEXT NOT NULL, steps_json TEXT NOT NULL, link_token TEXT NOT NULL, link_key TEXT NOT NULL,
    link_expires_at_ms INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  sql.exec("CREATE TABLE IF NOT EXISTS fill_link_cleanup(link_key TEXT PRIMARY KEY)");
}

// Width and height from a PNG's header, or null when it has none.
function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return null;
  if (String.fromCharCode(...png.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// A focus off the screenshot shows the whole screenshot instead: it is a
// hint for the close-up, and the step is still worth showing.
function focusOn(raw: unknown, size: { width: number; height: number }): Point | null {
  if (raw === undefined || raw === null) return null;
  const { x, y } = raw as { x?: unknown; y?: unknown };
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new ReplayInputError("A step's focus must be whole pixels.");
  const [px, py] = [x as number, y as number];
  return px >= 0 && px < size.width && py >= 0 && py < size.height ? { x: px, y: py } : null;
}

function plainText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseReplayInput(raw: unknown): ReplayInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ReplayInputError("Body must be a JSON object.");
  const { labels, steps } = raw as { labels?: unknown; steps?: unknown };
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) throw new ReplayInputError("labels must map field names to labels.");
  const labelEntries = Object.entries(labels);
  if (labelEntries.length > MAX_LABELS || labelEntries.some(([k, v]) => !LABEL_KEY.test(k) || !plainText(v))) {
    throw new ReplayInputError("labels must map field names to short labels.");
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_REPLAY_STEPS) {
    throw new ReplayInputError(`steps must hold 1 to ${MAX_REPLAY_STEPS} steps.`);
  }
  let total = 0;
  const parsed = steps.map((step: unknown) => {
    const { caption, pngB64, focus } = (step ?? {}) as { caption?: unknown; pngB64?: unknown; focus?: unknown };
    if (!plainText(caption)) throw new ReplayInputError("Each step needs a one-line caption.");
    let png: Uint8Array;
    try {
      png = base64ToBytes(typeof pngB64 === "string" ? pngB64 : "");
    } catch {
      throw new ReplayInputError("Each step needs its screenshot as base64.");
    }
    const size = pngSize(png);
    if (png.length > MAX_STEP_BYTES || !size) throw new ReplayInputError(`Each screenshot must be a PNG of at most ${MAX_STEP_BYTES} bytes.`);
    total += png.length;
    return { caption, png, focus: focusOn(focus, size) };
  });
  if (total > MAX_REPLAY_BYTES) throw new ReplayInputError(`The screenshots must total at most ${MAX_REPLAY_BYTES} bytes.`);
  return { labels: Object.fromEntries(labelEntries) as Record<string, string>, steps: parsed };
}

export function getFillReplay(sql: SqlExec, approvalId: string): StoredReplay | null {
  const row = sql.exec("SELECT * FROM fill_replays WHERE approval_id = ?", approvalId).toArray()[0] as
    | {
        approval_id: string;
        request_hash: string;
        generation: number;
        labels_json: string;
        steps_json: string;
        link_token: string;
        link_expires_at_ms: number;
      }
    | undefined;
  if (!row) return null;
  return {
    approvalId: row.approval_id,
    requestHash: row.request_hash,
    generation: Number(row.generation),
    labels: JSON.parse(row.labels_json) as Record<string, string>,
    steps: JSON.parse(row.steps_json) as StoredReplay["steps"],
    linkToken: row.link_token,
    linkExpiresAtMs: Number(row.link_expires_at_ms),
  };
}

// Deletes every replay row and queues its link entry for deletion; call
// it inside the conversation delete's transaction. The images go with
// the documents.
export function removeFillReplays(sql: SqlExec): void {
  sql.exec("INSERT OR IGNORE INTO fill_link_cleanup(link_key) SELECT link_key FROM fill_replays");
  sql.exec("DELETE FROM fill_replays");
}

// Deletes the queued link entries from storage, then the queue. Safe to
// repeat: a failure leaves the queue for the next call.
export async function finishLinkCleanup(sql: SqlExec, deleteObjects: (keys: string[]) => Promise<void>): Promise<void> {
  const keys = (sql.exec("SELECT link_key FROM fill_link_cleanup").toArray() as { link_key: string }[]).map((r) => r.link_key);
  if (keys.length === 0) return;
  await deleteObjects(keys);
  for (const key of keys) sql.exec("DELETE FROM fill_link_cleanup WHERE link_key = ?", key);
}

// The link's token while it still opens, or null.
export function replayLinkToken(sql: SqlExec, approvalId: string, nowMs: number): string | null {
  const replay = getFillReplay(sql, approvalId);
  return replay && replay.linkExpiresAtMs > nowMs ? replay.linkToken : null;
}

export async function linkKey(token: string): Promise<string> {
  return `fill-links/v1/${await sha256Hex(`mano-fill-link:v1:${token}`)}`;
}

function mintToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function imageId(approvalId: string, index: number): string {
  return `fill-${approvalId}-${index}`;
}

// Binds a recorded fill to the approval it produced. Images and the link
// entry are written first; the row commits only while the approval still
// waits, under the same hash, in the generation the bind was prepared
// under. A bind that loses removes what it wrote and nothing else.
export async function bindFillReplay(
  deps: { sql: SqlExec; approvals: ReplayApprovals; storage: ReplayStorage; personId: string; nowMs: number },
  approvalId: string,
  input: ReplayInput,
  generation: number,
): Promise<BindOutcome> {
  const { sql, approvals, storage } = deps;
  const existing = getFillReplay(sql, approvalId);
  if (existing) return { status: "existing", token: existing.linkToken };
  const approval = approvals.getApproval(approvalId);
  if (!approval) return { status: "not_found" };
  if (generation !== currentGeneration(sql)) return { status: "stale" };
  if (approval.status !== "pending" || !approvals.approvalCurrent(approvalId)) return { status: "closed" };

  const token = mintToken();
  const expiresAtMs = deps.nowMs + REPLAY_LINK_TTL_MS;
  const key = await linkKey(token);
  // Removes what this bind wrote and no row holds: after it loses, or
  // after a write failed partway.
  const discard = async (written: string[]) => {
    const kept = new Set(getFillReplay(sql, approvalId)?.steps.map((s) => s.r2Key) ?? []);
    await storage.deleteObjects(written.filter((k) => !kept.has(k)));
  };
  const puts = await Promise.allSettled(input.steps.map((step, i) => storage.putImage(imageId(approvalId, i), step.png, generation)));
  const stored = puts.flatMap((p) => (p.status === "fulfilled" ? [p.value.r2Key] : []));
  const failed = puts.find((p): p is PromiseRejectedResult => p.status === "rejected");
  if (failed) {
    await discard(stored);
    throw failed.reason;
  }
  try {
    await storage.putLink(key, { personId: deps.personId, approvalId, expiresAtMs });
  } catch (err) {
    await discard([key, ...stored]);
    throw err;
  }
  const images = puts.map((p) => (p as PromiseFulfilledResult<{ hash: string; r2Key: string }>).value);
  const steps: StoredStep[] = input.steps.map((step, i) => ({
    caption: step.caption,
    hash: images[i]!.hash,
    r2Key: images[i]!.r2Key,
    ...pngSize(step.png)!,
    focus: step.focus,
  }));
  const written = sql.exec(
    `INSERT OR IGNORE INTO fill_replays(approval_id, request_hash, generation, labels_json, steps_json, link_token, link_key, link_expires_at_ms, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${CURRENT_GENERATION} = ?
       AND EXISTS (SELECT 1 FROM approvals WHERE id = ? AND status = 'pending' AND request_hash = ? AND generation = ?)`,
    approvalId, approval.requestHash, generation, JSON.stringify(input.labels), JSON.stringify(steps), token, key, expiresAtMs,
    new Date(deps.nowMs).toISOString(), generation, approvalId, approval.requestHash, generation,
  ).rowsWritten;
  if (written > 0) return { status: "created", token };

  await discard([key, ...stored]);
  const raced = getFillReplay(sql, approvalId);
  if (raced) return { status: "existing", token: raced.linkToken };
  return generation !== currentGeneration(sql) ? { status: "stale" } : { status: "closed" };
}

interface ReplayFacts {
  status: Approval["status"];
  boundHash: string;
  requestHash: string;
  current: boolean;
  latest: boolean;
  expired: boolean;
}

// The state the approval's own row decides, or null while it still waits
// for a yes: then only the document check can say whether it is current.
function settledState(facts: ReplayFacts): ReplayState | null {
  if (!facts.current) return "closed";
  if (facts.boundHash !== facts.requestHash) return "changed";
  if (facts.status === "approved") return "approved";
  if (facts.status === "stale" || !facts.latest) return "changed";
  if (facts.status !== "pending" || facts.expired) return "closed";
  return null;
}

// The page for one approval's replay, or null when there is none for
// this token. exact asks the gateway whether a YES now would send
// exactly what the approval froze.
export async function replayPage(
  deps: { sql: SqlExec; approvals: ReplayApprovals; storage: ReplayStorage; nowMs: number; exact: (approval: Approval) => Promise<boolean> },
  approvalId: string,
  token: string,
): Promise<string | null> {
  // Read again after every wait: other requests to this person run while
  // the document and the images are read, and may decline, replace or
  // delete this version in between.
  const read = () => {
    const replay = getFillReplay(deps.sql, approvalId);
    if (!replay || !timingSafeEqual(replay.linkToken, token) || replay.linkExpiresAtMs <= deps.nowMs) return null;
    const approval = deps.approvals.getApproval(approvalId);
    if (!approval) return null;
    const facts: ReplayFacts = {
      status: approval.status,
      boundHash: replay.requestHash,
      requestHash: approval.requestHash,
      current: deps.approvals.approvalCurrent(approvalId),
      latest: deps.approvals.proposalCurrent(approvalId),
      expired: Date.parse(approval.expiresAt) <= deps.nowMs,
    };
    return { replay, approval, facts };
  };
  const first = read();
  if (!first) return null;
  const early = settledState(first.facts);
  if (early === "changed" || early === "closed") return renderReplayPage({ state: early });
  const images = await Promise.all(first.replay.steps.map((s, i) => deps.storage.getImage(imageId(approvalId, i), s.r2Key)));
  // The document is checked after the images and the rows after both, so
  // nothing a page shows as current changed during an earlier wait.
  const exact = early === null ? await deps.exact(first.approval) : true;
  const now = read();
  if (!now) return null;
  const state = settledState(now.facts) ?? (exact ? "current" : "changed");
  if (state === "changed" || state === "closed") return renderReplayPage({ state });
  if (images.some((png) => png === null)) return null;
  const { replay, approval } = now;
  return renderReplayPage({
    state,
    purpose: approval.purpose,
    recipient: approval.recipient,
    steps: replay.steps.map((s, i) => ({ ...s, png: images[i]! })),
    ...frozenFields(approval.requestJson, replay.labels),
  });
}

// The values Engine will send, read from the frozen request, under the
// form's labels in the form's order.
function frozenFields(requestJson: string, labels: Record<string, string>): { fields: { label: string; value: string }[]; attached: boolean } {
  let payload: Record<string, unknown> = {};
  let attached = false;
  try {
    const frozen = JSON.parse(requestJson) as { payload?: Record<string, unknown>; documentId?: unknown };
    payload = frozen.payload ?? {};
    attached = typeof frozen.documentId === "string" && frozen.documentId !== "";
  } catch {
    return { fields: [], attached };
  }
  const order = Object.keys(labels);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const fields = Object.entries(payload)
    .filter((e): e is [string, string | number] => typeof e[1] === "string" || typeof e[1] === "number")
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, v]) => ({ label: Object.hasOwn(labels, k) ? labels[k]! : k, value: String(v) }));
  return { fields, attached };
}

export type ReplayView =
  | {
      state: "current" | "approved";
      purpose: string;
      recipient: string;
      steps: (Pick<StoredStep, "caption" | "width" | "height" | "focus"> & { png: Uint8Array })[];
      fields: { label: string; value: string }[];
      attached: boolean;
    }
  | { state: "changed" | "closed" | "missing" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f4f4f1;color:#1d1d1b;font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 8px}
h2{font-size:1.1rem;margin:40px 0 12px}
p{margin:0 0 12px}
ol{margin:24px 0 0;padding:0;list-style:none}
li{margin:0 0 28px}
li p{margin:0 0 8px}
img{display:block;width:100%;height:auto;background:#fff}
.zoom{position:relative;aspect-ratio:16/9;overflow:hidden;background:#fff}
.zoom img{position:absolute;max-width:none}
dl{margin:0}
dl div{padding:10px 0}
dt{color:#5f5f5a;font-size:.9rem}
dd{margin:0;font-weight:600;overflow-wrap:anywhere}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

// What a page says when it shows no steps.
const NOTICES: Record<"changed" | "closed" | "missing", { title: string; text: string }> = {
  changed: {
    title: "This form changed",
    text: "This version changed after Mano shared this link. Nothing was sent, and this version never will be. Text Mano to see the latest one.",
  },
  closed: { title: "This form is closed", text: "This version will not be sent. Text Mano if you want to start it again." },
  missing: { title: "This page is not available", text: "The link may have expired. Text Mano to see your form again." },
};

export function renderReplayPage(view: ReplayView): string {
  if (view.state === "current" || view.state === "approved") return stepsPage(view);
  const notice = NOTICES[view.state];
  return page(notice.title, `<h1>${notice.title}</h1><p>${notice.text}</p>`);
}

// A step that typed shows the field up close: the screenshot at ZOOM
// times the page's width in a 16:9 window, with where Mano clicked 70%
// across (a form's labels sit left of its fields) and halfway down, kept
// inside the screenshot's edges. At 2x a 1280-pixel screen shows the
// field's label and value whole on a phone.
const ZOOM = 2;
const WINDOW = 16 / 9;
const ACROSS = 70;

type ViewStep = Extract<ReplayView, { steps: unknown }>["steps"][number];

function image(step: ViewStep, alt: string, style = ""): string {
  return `<img src="data:image/png;base64,${bytesToBase64(step.png)}" alt="${alt}"${style ? ` style="${style}"` : ""}>`;
}

function stepView(step: ViewStep): string {
  if (!step.focus) return image(step, "The form after this step");
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const left = clamp(ACROSS - (100 * ZOOM * step.focus.x) / step.width, 100 - 100 * ZOOM, 0);
  const top = clamp(50 - (100 * ZOOM * step.focus.y * WINDOW) / step.width, 100 - (100 * ZOOM * step.height * WINDOW) / step.width, 0);
  return `<div class="zoom">${image(step, "Close-up of the form after this step", `width:${100 * ZOOM}%;left:${left.toFixed(2)}%;top:${top.toFixed(2)}%`)}</div>`;
}

function stepsPage(view: Extract<ReplayView, { steps: unknown }>): string {
  const status =
    view.state === "current"
      ? "This is exactly what Mano will send when you reply YES. Nothing is sent before that."
      : "You said yes to this version.";
  const steps = view.steps.map((s, i) => `<li><p>${i + 1}. ${escapeHtml(s.caption)}</p>${stepView(s)}</li>`).join("");
  // The replay ends on the whole form as Mano left it.
  const last = view.steps[view.steps.length - 1]!;
  const whole = last.focus ? `<h2>The filled form</h2>${image(last, "The whole form, filled")}` : "";
  const rows = [{ label: "Goes to", value: view.recipient }, ...view.fields];
  const fields = rows.map((f) => `<div><dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(f.value)}</dd></div>`).join("");
  const sends = view.state === "current" ? "What Mano will send" : "What you said yes to";
  const close = view.state === "current" ? "<p>Reply YES to Mano's text to send exactly this, or NO to stop.</p>" : "";
  return page(
    "Your form, step by step",
    `<h1>${escapeHtml(view.purpose)}</h1><p>${status}</p><ol>${steps}</ol>${whole}<h2>${sends}</h2><dl>${fields}</dl>${view.attached ? "<p>With your document attached.</p>" : ""}${close}`,
  );
}

// Headers for every replay page: never cached, indexed, framed or
// referred, and nothing loads but the inline images and style.
export const REPLAY_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
