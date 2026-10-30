// Deadlines Mano tracks itself. A date from a letter, a case or the
// person becomes a tracked deadline in the person's own SQLite, and Mano
// schedules its own nudges: 14, 7 and 2 days out and the day of, at the
// nudge time (MANO_NUDGE_TIME, default 10:00) in the zone of the
// person's state, Pacific when it is unknown. A deadline learned after its
// first nudge day gets one nudge at the next nudge time instead, unless a
// planned one is less than 3 days away.
//
// Each nudge is a reminder row (agents/agent-state.ts), so it goes out
// from the person's one delivery wake-up through Channels' agent-send
// route like every reminder: STOP and closed conversations refuse there,
// the conversation generation fences it, and its key dedupes a re-send
// after a crash. On top of that a nudge only goes inside 9:00 to 20:00
// local on its own day; earlier it waits, later it is dropped, so a count
// like "in 7 days" is never sent on the wrong day. A nudge only asks
// ("Want me to start it?"); acting still needs the person's yes on an
// approval.
//
// Routes, for the person's session or the agent service (contract shared
// with Mail):
//   POST   /deadlines       { title, dueDate: "YYYY-MM-DD", program?, source: { kind, documentId?, sentence? },
//                            idempotencyKey, generation? }. The same key is the same deadline; a new date
//                            for it answers moved with both dates and replaces the nudges not yet sent.
//   GET    /deadlines       open ones first, each with its nudges
//   PATCH  /deadlines/:id   { dueDate?, title?, status?: "done" } change it, or mark it done
//   DELETE /deadlines/:id   stop tracking it
// Tests: test-node/deadlines.test.ts (SQLite) and test/deadlines-routes.test.ts (worker, alarm).
import {
  AgentStateInputError,
  cancelReminder,
  createReminder,
  currentGeneration,
  isGeneration,
  type ReminderStatus,
} from "./agents/agent-state.js";
import { sha256Hex } from "./hash.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

export const NUDGE_DAYS = [14, 7, 2, 0] as const;
const CATCH_UP_GAP_DAYS = 3;
const WINDOW_OPENS_HOUR = 9;
const WINDOW_CLOSES_HOUR = 20;
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const NUDGE_PREFIX = "nudge:";
const MAX_TITLE = 120;
const MAX_PROGRAM = 80;
const MAX_SENTENCE = 1000;
const MAX_KEY = 256;
const MAX_DOCUMENT_ID = 128;
const MAX_AHEAD_DAYS = 731;
const DEADLINE_ID = /^dl-[0-9a-f]{32}$/;

export type DeadlineStatus = "open" | "done" | "cancelled";
export type SourceKind = "letter" | "case" | "person";
const SOURCE_KINDS: readonly SourceKind[] = ["letter", "case", "person"];

export interface DeadlineSource {
  kind: SourceKind;
  documentId?: string;
  sentence?: string;
}

export interface DeadlineInput {
  title: string;
  dueDate: string;
  program?: string;
  source: DeadlineSource;
  idempotencyKey: string;
  generation?: number;
}

export interface DeadlinePatch {
  title?: string;
  dueDate?: string;
  status?: "done";
}

export interface NudgeView {
  reminderId: string;
  at: string;
  daysBefore: number;
  status: ReminderStatus;
  text: string;
}

export interface Deadline {
  id: string;
  title: string;
  dueDate: string;
  program: string | null;
  source: DeadlineSource;
  status: DeadlineStatus;
  timeZone: string;
  previousDueDate: string | null;
  createdAt: string;
  updatedAt: string;
  // Every nudge but the ones withdrawn before they went: what was sent,
  // dropped or is still to come.
  nudges: NudgeView[];
}

// created, existing (same key, nothing changed), moved (new date),
// updated (new title), closed (it was done or cancelled before: left as
// it is), done and cancelled (this call closed it). nudgesInFlight counts
// nudges already handed to Channels when it closed, which may still land.
export type DeadlineResult =
  | {
      status: "created" | "existing" | "moved" | "updated" | "closed" | "done" | "cancelled";
      deadline: Deadline;
      moved?: { from: string; to: string };
      nudgesInFlight?: number;
    }
  | { stale: true };

// Calendar dates and zoned wall time.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function dateMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(dateMs(value)).toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / 86_400_000);
}

const formats = new Map<string, Intl.DateTimeFormat>();

function wall(ms: number, timeZone: string): { date: string; asUtcMs: number } {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(timeZone, format);
  }
  const p: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return { date: new Date(Date.UTC(p.year, p.month - 1, p.day)).toISOString().slice(0, 10), asUtcMs };
}

// The instant a wall time on a date happens in a zone. Two passes settle
// the offset on either side of a daylight saving change.
export function zonedInstant(date: string, hour: number, minute: number, timeZone: string): number {
  const target = dateMs(date) + (hour * 60 + minute) * 60_000;
  const offset = (ms: number) => wall(ms, timeZone).asUtcMs - Math.floor(ms / 1000) * 1000;
  const first = target - offset(target);
  return target - offset(first);
}

// The person's zone, from the two-letter state on their profile. A state
// split across zones takes the zone most of its people live in.
const STATE_ZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago",
  WY: "America/Denver", PR: "America/Puerto_Rico", GU: "Pacific/Guam", VI: "America/St_Thomas", AS: "Pacific/Pago_Pago",
  MP: "Pacific/Saipan",
};

export function timeZoneForState(state: string | null | undefined): string {
  return (state && STATE_ZONES[state.trim().toUpperCase()]) || DEFAULT_TIME_ZONE;
}

// MANO_NUDGE_TIME, "HH:MM" inside the 9:00 to 20:00 window; anything
// else is the default 10:00.
export interface NudgeTime {
  hour: number;
  minute: number;
}

export function nudgeTimeOf(env: { MANO_NUDGE_TIME?: string }): NudgeTime {
  const match = /^(\d{2}):(\d{2})$/.exec(env.MANO_NUDGE_TIME ?? "");
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const at = hour * 60 + minute;
    if (minute < 60 && at >= WINDOW_OPENS_HOUR * 60 && at < WINDOW_CLOSES_HOUR * 60) return { hour, minute };
  }
  return { hour: 10, minute: 0 };
}

export interface PlannedNudge {
  daysBefore: number;
  localDate: string;
  atMs: number;
  windowStartMs: number;
  windowEndMs: number;
}

export function planNudges(dueDate: string, timeZone: string, nowMs: number, time: NudgeTime): PlannedNudge[] {
  const plan = (localDate: string): PlannedNudge => ({
    daysBefore: daysBetween(localDate, dueDate),
    localDate,
    atMs: zonedInstant(localDate, time.hour, time.minute, timeZone),
    windowStartMs: zonedInstant(localDate, WINDOW_OPENS_HOUR, 0, timeZone),
    windowEndMs: zonedInstant(localDate, WINDOW_CLOSES_HOUR, 0, timeZone),
  });
  const planned = NUDGE_DAYS.map((days) => plan(addDays(dueDate, -days)));
  const ahead = planned.filter((n) => n.atMs > nowMs);
  if (ahead.length < planned.length) {
    const today = wall(nowMs, timeZone).date;
    let next = plan(today);
    if (next.atMs <= nowMs) next = plan(addDays(today, 1));
    const soonAfter = ahead.some((n) => daysBetween(next.localDate, n.localDate) < CATCH_UP_GAP_DAYS);
    if (next.localDate <= dueDate && !soonAfter) ahead.unshift(next);
  }
  return ahead;
}

export function nudgeText(title: string, daysBefore: number, dueDate: string): string {
  const name = title.replace(/^your\s+/i, "");
  const [, m, d] = dueDate.split("-").map(Number);
  const when = daysBefore === 0 ? "today" : daysBefore === 1 ? "tomorrow" : `in ${daysBefore} days, on ${MONTHS[m - 1]} ${d}`;
  return `Your ${name} is due ${when}. Want me to start it?`;
}

// Input. Throws AgentStateInputError, which the routes answer with 400.

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AgentStateInputError("Body must be a JSON object.");
  return raw as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  const cleaned = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  if (!cleaned || cleaned.length > max) throw new AgentStateInputError(`${field} must be 1 to ${max} characters.`);
  return cleaned;
}

function dueDateOf(value: unknown): string {
  if (!isIsoDate(value)) throw new AgentStateInputError("dueDate must be a real date written YYYY-MM-DD.");
  if (daysBetween(new Date().toISOString().slice(0, 10), value) > MAX_AHEAD_DAYS) {
    throw new AgentStateInputError("dueDate is more than two years out.");
  }
  return value;
}

export function parseDeadlineInput(raw: unknown): DeadlineInput {
  const f = object(raw);
  const s = object(f.source);
  if (!SOURCE_KINDS.includes(s.kind as SourceKind)) throw new AgentStateInputError("source.kind must be letter, case or person.");
  const source: DeadlineSource = { kind: s.kind as SourceKind };
  if (s.documentId !== undefined) source.documentId = text(s.documentId, "source.documentId", MAX_DOCUMENT_ID);
  if (s.sentence !== undefined) source.sentence = text(s.sentence, "source.sentence", MAX_SENTENCE);
  if (typeof f.idempotencyKey !== "string" || !f.idempotencyKey || f.idempotencyKey.length > MAX_KEY) {
    throw new AgentStateInputError(`idempotencyKey must be 1 to ${MAX_KEY} characters.`);
  }
  const input: DeadlineInput = {
    title: text(f.title, "title", MAX_TITLE),
    dueDate: dueDateOf(f.dueDate),
    source,
    idempotencyKey: f.idempotencyKey,
  };
  if (f.program !== undefined && f.program !== null) input.program = text(f.program, "program", MAX_PROGRAM);
  if (f.generation !== undefined) {
    if (!isGeneration(f.generation)) throw new AgentStateInputError("generation must be a whole number, 0 or more.");
    input.generation = f.generation;
  }
  return input;
}

export function parseDeadlinePatch(raw: unknown): DeadlinePatch {
  const f = object(raw);
  const patch: DeadlinePatch = {};
  if (f.title !== undefined) patch.title = text(f.title, "title", MAX_TITLE);
  if (f.dueDate !== undefined) patch.dueDate = dueDateOf(f.dueDate);
  if (f.status !== undefined) {
    if (f.status !== "done") throw new AgentStateInputError('status can only be "done".');
    patch.status = "done";
  }
  if (Object.keys(patch).length === 0) throw new AgentStateInputError("Send a dueDate, a title or status done.");
  return patch;
}

export async function deadlineIdFor(idempotencyKey: string): Promise<string> {
  return `dl-${(await sha256Hex(`deadline\n${idempotencyKey}`)).slice(0, 32)}`;
}

export function isNudge(reminderId: string): boolean {
  return reminderId.startsWith(NUDGE_PREFIX);
}

// Storage. Callers run each change in one transaction.

export function ensureDeadlineTables(sql: SqlExec): void {
  // An earlier, never-written deadlines table had other columns.
  const cols = sql.exec("PRAGMA table_info(deadlines)").toArray() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "idempotency_key")) sql.exec("DROP TABLE deadlines");
  sql.exec(`CREATE TABLE IF NOT EXISTS deadlines(
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, due_date TEXT NOT NULL,
    program TEXT, source_json TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
    previous_due_date TEXT, time_zone TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER)`);
  // Each nudge's reminder row, and the 9:00 to 20:00 window of its day.
  sql.exec(`CREATE TABLE IF NOT EXISTS deadline_nudges(
    reminder_id TEXT PRIMARY KEY, deadline_id TEXT NOT NULL, revision INTEGER NOT NULL, days_before INTEGER NOT NULL,
    window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL)`);
  sql.exec("CREATE INDEX IF NOT EXISTS deadline_nudges_by_deadline ON deadline_nudges(deadline_id)");
}

interface Row {
  id: string;
  title: string;
  due_date: string;
  program: string | null;
  source_json: string;
  status: DeadlineStatus;
  revision: number;
  previous_due_date: string | null;
  time_zone: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function row(sql: SqlExec, id: string): Row | null {
  return (sql.exec("SELECT * FROM deadlines WHERE id = ?", id).toArray()[0] as Row | undefined) ?? null;
}

function view(sql: SqlExec, r: Row): Deadline {
  const nudges = sql
    .exec(
      "SELECT n.reminder_id, n.days_before, r.due_at_ms, r.status, r.text FROM deadline_nudges n JOIN reminders r ON r.id = n.reminder_id" +
        " WHERE n.deadline_id = ? AND r.status != 'cancelled' ORDER BY r.due_at_ms, n.reminder_id",
      r.id,
    )
    .toArray() as { reminder_id: string; days_before: number; due_at_ms: number; status: ReminderStatus; text: string }[];
  return {
    id: r.id,
    title: r.title,
    dueDate: r.due_date,
    program: r.program,
    source: JSON.parse(r.source_json) as DeadlineSource,
    status: r.status,
    timeZone: r.time_zone,
    previousDueDate: r.previous_due_date,
    createdAt: new Date(Number(r.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(r.updated_at_ms)).toISOString(),
    nudges: nudges.map((n) => ({
      reminderId: n.reminder_id,
      at: new Date(Number(n.due_at_ms)).toISOString(),
      daysBefore: Number(n.days_before),
      status: n.status,
      text: n.text,
    })),
  };
}

export function listDeadlines(sql: SqlExec): Deadline[] {
  const rows = sql.exec("SELECT * FROM deadlines ORDER BY status != 'open', due_date, id").toArray() as Row[];
  return rows.map((r) => view(sql, r));
}

// Nudges for the deadline's current revision, under the conversation
// generation current now. IDs carry the revision, so a moved date never
// collides with the nudges it replaced.
function scheduleNudges(sql: SqlExec, r: Row, nowMs: number, time: NudgeTime): void {
  const generation = currentGeneration(sql);
  for (const n of planNudges(r.due_date, r.time_zone, nowMs, time)) {
    const reminderId = `${NUDGE_PREFIX}${r.id}:${r.revision}:${n.daysBefore}`;
    createReminder(sql, { id: reminderId, text: nudgeText(r.title, n.daysBefore, r.due_date), dueAtMs: n.atMs, generation }, nowMs);
    sql.exec(
      "INSERT OR IGNORE INTO deadline_nudges(reminder_id, deadline_id, revision, days_before, window_start_ms, window_end_ms) VALUES (?, ?, ?, ?, ?, ?)",
      reminderId, r.id, r.revision, n.daysBefore, n.windowStartMs, n.windowEndMs,
    );
  }
}

// Withdraws every nudge not yet handed to Channels. Returns how many
// were already handed off: those may still land and are never called back.
function stopNudges(sql: SqlExec, deadlineId: string, nowMs: number): number {
  const ids = sql.exec("SELECT reminder_id FROM deadline_nudges WHERE deadline_id = ?", deadlineId).toArray() as { reminder_id: string }[];
  let inFlight = 0;
  for (const { reminder_id } of ids) {
    const out = cancelReminder(sql, reminder_id, nowMs);
    if (out.reason === "already on its way" && out.reminder?.status === "sending") inFlight += 1;
  }
  return inFlight;
}

function revise(sql: SqlExec, r: Row, next: { title: string; dueDate: string; timeZone: string }, nowMs: number, time: NudgeTime): DeadlineResult {
  stopNudges(sql, r.id, nowMs);
  const moved = next.dueDate !== r.due_date;
  sql.exec(
    "UPDATE deadlines SET title = ?, due_date = ?, previous_due_date = ?, time_zone = ?, revision = revision + 1, updated_at_ms = ? WHERE id = ?",
    next.title, next.dueDate, moved ? r.due_date : r.previous_due_date, next.timeZone, nowMs, r.id,
  );
  const updated = row(sql, r.id)!;
  scheduleNudges(sql, updated, nowMs, time);
  return moved
    ? { status: "moved", deadline: view(sql, updated), moved: { from: r.due_date, to: next.dueDate } }
    : { status: "updated", deadline: view(sql, updated) };
}

export function trackDeadline(
  sql: SqlExec,
  input: DeadlineInput & { id: string; timeZone: string },
  nowMs: number,
  time: NudgeTime,
): DeadlineResult {
  if (input.generation !== undefined && input.generation !== currentGeneration(sql)) return { stale: true };
  const existing = row(sql, input.id);
  if (!existing) {
    sql.exec(
      "INSERT INTO deadlines(id, idempotency_key, title, due_date, program, source_json, status, revision, time_zone, created_at_ms, updated_at_ms)" +
        " VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)",
      input.id, input.idempotencyKey, input.title, input.dueDate, input.program ?? null, JSON.stringify(input.source), input.timeZone, nowMs, nowMs,
    );
    const created = row(sql, input.id)!;
    scheduleNudges(sql, created, nowMs, time);
    return { status: "created", deadline: view(sql, created) };
  }
  if (existing.status !== "open") return { status: "closed", deadline: view(sql, existing) };
  if (input.program !== undefined && input.program !== existing.program) {
    sql.exec("UPDATE deadlines SET program = ?, updated_at_ms = ? WHERE id = ?", input.program, nowMs, existing.id);
  }
  if (input.title === existing.title && input.dueDate === existing.due_date) {
    return { status: "existing", deadline: view(sql, row(sql, existing.id)!) };
  }
  return revise(sql, existing, { title: input.title, dueDate: input.dueDate, timeZone: input.timeZone }, nowMs, time);
}

export function updateDeadline(
  sql: SqlExec,
  id: string,
  patch: DeadlinePatch,
  timeZone: string,
  nowMs: number,
  time: NudgeTime,
): DeadlineResult | null {
  const r = row(sql, id);
  if (!r) return null;
  if (r.status !== "open") return { status: "closed", deadline: view(sql, r) };
  if (patch.status === "done") return close(sql, r, "done", nowMs);
  const next = { title: patch.title ?? r.title, dueDate: patch.dueDate ?? r.due_date, timeZone };
  if (next.title === r.title && next.dueDate === r.due_date) return { status: "existing", deadline: view(sql, r) };
  return revise(sql, r, next, nowMs, time);
}

export function cancelDeadline(sql: SqlExec, id: string, nowMs: number): DeadlineResult | null {
  const r = row(sql, id);
  if (!r) return null;
  if (r.status === "cancelled") return { status: "cancelled", deadline: view(sql, r), nudgesInFlight: 0 };
  if (r.status !== "open") return { status: "closed", deadline: view(sql, r) };
  return close(sql, r, "cancelled", nowMs);
}

function close(sql: SqlExec, r: Row, status: "done" | "cancelled", nowMs: number): DeadlineResult {
  const nudgesInFlight = stopNudges(sql, r.id, nowMs);
  sql.exec("UPDATE deadlines SET status = ?, closed_at_ms = ?, updated_at_ms = ? WHERE id = ?", status, nowMs, nowMs, r.id);
  return { status, deadline: view(sql, row(sql, r.id)!), nudgesInFlight };
}

// A conversation delete removes the deadlines with everything else Mano
// kept; removeConversationState has already withdrawn their nudges.
export function removeDeadlines(sql: SqlExec): number {
  const n = Number((sql.exec("SELECT COUNT(*) AS n FROM deadlines").toArray()[0] as { n: number }).n);
  sql.exec("DELETE FROM deadline_nudges");
  sql.exec("DELETE FROM deadlines");
  return n;
}

// Quiet hours, checked by the delivery run on each claimed reminder
// before its handoff. null: not a nudge, or inside its window, so it
// goes. deferred: too early, it waits for 9:00 (a nudge already handed
// off stays sending). missed: its day's window closed, so it is dropped.
// Either way the run does not send it.
export function holdNudgeOutsideWindow(sql: SqlExec, reminderId: string, token: string, nowMs: number): "deferred" | "missed" | null {
  if (!isNudge(reminderId)) return null;
  const w = sql.exec("SELECT window_start_ms, window_end_ms FROM deadline_nudges WHERE reminder_id = ?", reminderId).toArray()[0] as
    | { window_start_ms: number; window_end_ms: number }
    | undefined;
  if (!w || (nowMs >= Number(w.window_start_ms) && nowMs < Number(w.window_end_ms))) return null;
  if (nowMs < Number(w.window_start_ms)) {
    sql.exec(
      "UPDATE reminders SET status = CASE WHEN handoffs = 0 THEN 'scheduled' ELSE status END, next_at_ms = ?," +
        " claim_token = NULL, claimed_at_ms = NULL, attempts = MAX(attempts - 1, 0)" +
        " WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
      Number(w.window_start_ms), reminderId, token,
    );
    return "deferred";
  }
  sql.exec(
    "UPDATE reminders SET status = 'dropped', finished_at_ms = ? WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
    nowMs, reminderId, token,
  );
  return "missed";
}

// The routes, over whichever store answers them: the PersonAgent in the
// worker, or a test double. null when the path is not a deadline route.
export interface DeadlineCalls {
  track(input: DeadlineInput): Promise<DeadlineResult>;
  list(): Promise<Deadline[]>;
  update(id: string, patch: DeadlinePatch): Promise<DeadlineResult | null>;
  cancel(id: string): Promise<DeadlineResult | null>;
}

const NOT_FOUND = () => Response.json({ error: "Deadline not found." }, { status: 404 });
const STALE = () =>
  Response.json({ error: "This conversation was deleted after the request was prepared. Nothing was written." }, { status: 409 });

export async function routeDeadlines(
  calls: DeadlineCalls,
  method: string,
  rest: string,
  readBody: () => Promise<unknown>,
): Promise<Response | null> {
  const one = rest.match(/^\/deadlines\/([^/]+)$/);
  if (rest !== "/deadlines" && !one) return null;
  try {
    if (rest === "/deadlines") {
      if (method === "GET") return Response.json({ deadlines: await calls.list() });
      if (method !== "POST") return null;
      const out = await calls.track(parseDeadlineInput(await readBody()));
      if ("stale" in out) return STALE();
      return Response.json(out, { status: out.status === "created" ? 201 : 200 });
    }
    const id = decodeURIComponent(one![1]);
    if (method !== "PATCH" && method !== "DELETE") return null;
    if (!DEADLINE_ID.test(id)) return NOT_FOUND();
    const out = method === "PATCH" ? await calls.update(id, parseDeadlinePatch(await readBody())) : await calls.cancel(id);
    if (!out) return NOT_FOUND();
    if ("stale" in out) return STALE();
    return Response.json(out);
  } catch (err) {
    if (err instanceof Response) return err;
    if (err instanceof AgentStateInputError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
