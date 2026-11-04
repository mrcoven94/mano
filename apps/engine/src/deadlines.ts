// Deadlines Mano tracks itself. A date from a letter, a case or the
// person becomes a tracked deadline in the person's own SQLite, and Mano
// schedules its own nudges: 14, 7 and 2 days out and the day of, at the
// nudge time (MANO_NUDGE_TIME, default 10:00) in the zone of the
// person's state, Pacific when it is unknown. An interview or a hearing,
// a date the person shows up for, gets the day before in place of 2 days
// out: that is when a reminder helps them get there, and three texts on
// three days running would be noise. A deadline learned after its
// first nudge day gets one nudge at the next nudge time instead, unless a
// planned one is less than 3 days away. Every send of the same deadline,
// a replay included, compares the nudges stored for it with its kind's
// days: a correction keeps the nudges not yet sent, drops a day the kind
// no longer has and adds one it lacks while its nudge time is ahead, and
// a moved date plans the new days, each slot whose day is still open
// (until 20:00) at the earliest allowed time from now, with no catch-up.
// A day already handed off for a date, or cancelled by the person, is
// never planned again for it.
//
// Each nudge is a reminder row (agents/agent-state.ts), so it goes out
// from the person's one delivery wake-up through Channels' agent-send
// route like every reminder: STOP and closed conversations refuse there,
// the conversation generation fences it, and its key dedupes a re-send
// after a crash. Before every handoff, retries included, a nudge is
// checked against its deadline: one whose deadline closed, moved or was
// deleted is withdrawn, never sent. It also only goes inside 9:00 to
// 20:00 local on its own day; earlier it waits, later it is dropped, so a
// count like "in 7 days" is never sent on the wrong day.
//
// A nudge never carries a letter's own words. It names the action only
// from the explicit kind (renewal, recertification, redetermination,
// interview, hearing, appeal, payment, documents) and the program only
// when it is a known one: "Your CalFresh renewal is due in 12 days".
// With no kind it names no action: "Your CalFresh deadline is in 12
// days", or "The deadline from the letter you sent on October 27" by
// the day the letter arrived.
// The title is kept only for the agent, quoted as data. A nudge for
// paperwork asks ("Want me to start it?"); acting still needs the
// person's yes on an approval. One for a date the person shows up for
// only says when: "Your Medi-Cal interview is tomorrow."
//
// Routes, for the person's session or the agent service (contract shared
// with Mail):
//   POST   /deadlines       { title, dueDate: "YYYY-MM-DD", program?, kind?, source: { kind, documentId?,
//                            sentence?, receivedAt? }, idempotencyKey, generation }. The same key is the same deadline; a new date
//                            for it answers moved with both dates and replaces the nudges not yet sent.
//                            generation is the conversation generation the request was prepared under:
//                            required from every caller, 409 when a delete has moved past it.
//   GET    /deadlines       open ones first, each with its nudges
//   PATCH  /deadlines/:id   { dueDate?, title?, status?: "done" } change it, or mark it done
//   DELETE /deadlines/:id   stop tracking it
// Tests: test-node/deadlines.test.ts (SQLite), test/deadlines-routes.test.ts (worker, alarm) and
// test/deadline-zones.test.ts (the zone from the profile's state, through the worker).
import {
  AgentStateInputError,
  createReminder,
  currentGeneration,
  isGeneration,
  type ReminderStatus,
} from "./agents/agent-state.js";
import { sha256Hex } from "./hash.js";

export { DEFAULT_TIME_ZONE, timeZoneForState } from "@mano/protocol";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

const CATCH_UP_GAP_DAYS = 3;
const WINDOW_OPENS_HOUR = 9;
const WINDOW_CLOSES_HOUR = 20;
const NUDGE_PREFIX = "nudge:";
const MAX_TITLE = 120;
const MAX_PROGRAM = 80;
const MAX_SENTENCE = 1000;
const MAX_KEY = 256;
const MAX_DOCUMENT_ID = 128;
const MAX_AHEAD_DAYS = 731;
const DEADLINE_ID = /^dl-[0-9a-f]{32}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_HH_MM = /^(\d{2}):(\d{2})$/;
const NON_ALPHANUMERIC = /[^a-z0-9]/g;
const CONTROL_CHAR_RUN = /[\u0000-\u001f\u007f]+/g;
const WHITESPACE_RUN = /\s+/g;
const DEADLINE_PATH = /^\/deadlines\/([^/]+)$/;

// The program names a nudge may use. Replaced by the Programs catalog
// once it lands.
const KNOWN_PROGRAMS = [
  "CalFresh", "SNAP", "Medi-Cal", "Medicaid", "Medicare", "WIC", "TANF", "CalWORKs", "SSI", "SSDI", "LIHEAP",
  "Section 8", "CHIP", "Covered California", "General Assistance",
];
export const DEADLINE_KINDS = ["renewal", "recertification", "redetermination", "interview", "hearing", "appeal", "payment", "documents"] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

// The days before the due date a nudge is planned for, by what the
// deadline asks of the person: paperwork to send, or a date to show up.
const ATTENDED_KINDS: readonly DeadlineKind[] = ["interview", "hearing"];
const PAPERWORK_DAYS = [14, 7, 2, 0] as const;
const ATTENDED_DAYS = [14, 7, 1, 0] as const;
// Every day a schedule plans. A stored day outside it is a catch-up.
const SCHEDULE_DAYS = new Set<number>([...PAPERWORK_DAYS, ...ATTENDED_DAYS]);

function isAttended(kind: DeadlineKind | null): boolean {
  return kind !== null && ATTENDED_KINDS.includes(kind);
}

export function nudgeDays(kind: DeadlineKind | null): readonly number[] {
  return isAttended(kind) ? ATTENDED_DAYS : PAPERWORK_DAYS;
}

export type DeadlineStatus = "open" | "done" | "cancelled";
export type SourceKind = "letter" | "case" | "person";
const SOURCE_KINDS: readonly SourceKind[] = ["letter", "case", "person"];

export interface DeadlineSource {
  kind: SourceKind;
  documentId?: string;
  sentence?: string;
  // When the letter reached Mano: YYYY-MM-DD or an ISO timestamp.
  receivedAt?: string;
}

export interface DeadlineInput {
  title: string;
  dueDate: string;
  program?: string;
  kind?: DeadlineKind;
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
  kind: DeadlineKind | null;
  source: DeadlineSource;
  status: DeadlineStatus;
  timeZone: string;
  previousDueDate: string | null;
  createdAt: string;
  updatedAt: string;
  // Every nudge but the ones withdrawn: what was sent, dropped or is
  // still to come.
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
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  return new Date(dateMs(value)).toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
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

export function localDate(ms: number, timeZone: string): string {
  return wall(ms, timeZone).date;
}

// The instant a wall time on a date happens in a zone. Two passes settle
// the offset on either side of a daylight saving change.
export function zonedInstant(date: string, hour: number, minute: number, timeZone: string): number {
  const target = dateMs(date) + (hour * 60 + minute) * 60_000;
  const offset = (ms: number) => wall(ms, timeZone).asUtcMs - Math.floor(ms / 1000) * 1000;
  const first = target - offset(target);
  return target - offset(first);
}

// MANO_NUDGE_TIME, "HH:MM" inside the 9:00 to 20:00 window; anything
// else is the default 10:00.
export interface NudgeTime {
  hour: number;
  minute: number;
}

export function nudgeTimeOf(env: { MANO_NUDGE_TIME?: string }): NudgeTime {
  const match = CLOCK_HH_MM.exec(env.MANO_NUDGE_TIME ?? "");
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

// first: a deadline Mano just learned, with one catch-up when it came in
// after its first nudge day. rebuild: a deadline whose date moved; every
// slot whose day's window is still open, at the earliest allowed time
// from now, and no catch-up. ahead: only the slots whose nudge time is
// still to come, as a first plan would have them. days: the slots.
export function planNudges(
  dueDate: string,
  timeZone: string,
  nowMs: number,
  time: NudgeTime,
  mode: "first" | "rebuild" | "ahead" = "first",
  days: readonly number[] = PAPERWORK_DAYS,
): PlannedNudge[] {
  const plan = (localDate: string): PlannedNudge => ({
    daysBefore: daysBetween(localDate, dueDate),
    localDate,
    atMs: zonedInstant(localDate, time.hour, time.minute, timeZone),
    windowStartMs: zonedInstant(localDate, WINDOW_OPENS_HOUR, 0, timeZone),
    windowEndMs: zonedInstant(localDate, WINDOW_CLOSES_HOUR, 0, timeZone),
  });
  const planned = days.map((d) => plan(addDays(dueDate, -d)));
  if (mode === "ahead") return planned.filter((n) => n.atMs > nowMs);
  if (mode === "rebuild") return planned.filter((n) => n.windowEndMs > nowMs).map((n) => ({ ...n, atMs: Math.max(n.atMs, nowMs) }));
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

function monthDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function knownProgram(program: string | null): string | null {
  const key = (t: string) => t.toLowerCase().replace(NON_ALPHANUMERIC, "");
  return program ? (KNOWN_PROGRAMS.find((p) => key(p) === key(program)) ?? null) : null;
}

export interface NudgeNaming {
  program: string | null;
  kind: DeadlineKind | null;
  sourceKind: SourceKind;
  // The local day the letter arrived, when the source says; the day the
  // person told Mano, for their own.
  receivedOn: string | null;
  learnedOn: string;
}

// Only closed-set words and dates: never the letter's own text.
export function nudgeText(d: NudgeNaming, daysBefore: number, dueDate: string): string {
  const program = knownProgram(d.program);
  const when = daysBefore === 0 ? "today" : daysBefore === 1 ? "tomorrow" : `in ${daysBefore} days, on ${monthDay(dueDate)}`;
  if (d.kind && isAttended(d.kind)) return `Your ${program ? `${program} ` : ""}${d.kind} is ${when}.`;
  if (d.kind) {
    const verb = d.kind === "documents" ? "are" : "is";
    return `Your ${program ? `${program} ` : ""}${d.kind} ${verb} due ${when}. Want me to start it?`;
  }
  const name = program
    ? `Your ${program} deadline`
    : d.sourceKind === "letter"
      ? `The deadline from the letter you sent ${d.receivedOn ? `on ${monthDay(d.receivedOn)}` : "me"}`
      : d.sourceKind === "person"
        ? `The deadline you told me about on ${monthDay(d.learnedOn)}`
        : "The deadline on your case";
  return `${name} is ${when}.`;
}

// Input. Throws AgentStateInputError, which the routes answer with 400.

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AgentStateInputError("Body must be a JSON object.");
  return raw as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  const cleaned = typeof value === "string" ? value.replace(CONTROL_CHAR_RUN, " ").replace(WHITESPACE_RUN, " ").trim() : "";
  if (!cleaned || cleaned.length > max) throw new AgentStateInputError(`${field} must be 1 to ${max} characters.`);
  return cleaned;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isReceivedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = isIsoDate(value) ? value : TIMESTAMP.exec(value)?.[1];
  if (!date || !isIsoDate(date)) return false;
  const ms = Date.parse(isIsoDate(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) && ms <= Date.now();
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
  // A received date that is not a real calendar moment, or is in the
  // future, is no date: the nudge then says "the letter you sent me".
  if (isReceivedAt(s.receivedAt)) source.receivedAt = s.receivedAt;
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
  // An unknown kind is no kind: the nudge then names no action.
  if (DEADLINE_KINDS.includes(f.kind as DeadlineKind)) input.kind = f.kind as DeadlineKind;
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
    program TEXT, kind TEXT, source_json TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
    previous_due_date TEXT, time_zone TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER)`);
  // Each nudge's reminder row, the due date it counts down to (NULL on a
  // row written before that was kept), and the 9:00 to 20:00 window of
  // its day.
  sql.exec(`CREATE TABLE IF NOT EXISTS deadline_nudges(
    reminder_id TEXT PRIMARY KEY, deadline_id TEXT NOT NULL, revision INTEGER NOT NULL, days_before INTEGER NOT NULL,
    window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL, due_date TEXT)`);
  sql.exec("CREATE INDEX IF NOT EXISTS deadline_nudges_by_deadline ON deadline_nudges(deadline_id)");
  const nudgeCols = sql.exec("PRAGMA table_info(deadline_nudges)").toArray() as { name: string }[];
  if (!nudgeCols.some((c) => c.name === "due_date")) sql.exec("ALTER TABLE deadline_nudges ADD COLUMN due_date TEXT");
}

interface Row {
  id: string;
  title: string;
  due_date: string;
  program: string | null;
  kind: DeadlineKind | null;
  source_json: string;
  status: DeadlineStatus;
  revision: number;
  previous_due_date: string | null;
  time_zone: string;
  created_at_ms: number;
  updated_at_ms: number;
}

const DEADLINE_COLUMNS =
  "id, title, due_date, program, kind, source_json, status, revision, previous_due_date, time_zone, created_at_ms, updated_at_ms";

function row(sql: SqlExec, id: string): Row | null {
  return (sql.exec(`SELECT ${DEADLINE_COLUMNS} FROM deadlines WHERE id = ?`, id).toArray()[0] as Row | undefined) ?? null;
}

function view(sql: SqlExec, r: Row): Deadline {
  const nudges = sql
    .exec(
      "SELECT n.reminder_id, n.days_before, r.due_at_ms, r.status, r.text FROM deadline_nudges n JOIN reminders r ON r.id = n.reminder_id" +
        " WHERE n.deadline_id = ? AND r.status NOT IN ('cancelled', 'withdrawn') ORDER BY r.due_at_ms, n.reminder_id",
      r.id,
    )
    .toArray() as { reminder_id: string; days_before: number; due_at_ms: number; status: ReminderStatus; text: string }[];
  return {
    id: r.id,
    title: r.title,
    dueDate: r.due_date,
    program: r.program,
    kind: r.kind,
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
  const rows = sql.exec(`SELECT ${DEADLINE_COLUMNS} FROM deadlines ORDER BY status != 'open', due_date, id`).toArray() as Row[];
  return rows.map((r) => view(sql, r));
}

function namingOf(r: { program: string | null; kind: DeadlineKind | null; source_json: string; created_at_ms: number; time_zone: string }): NudgeNaming {
  const source = JSON.parse(r.source_json) as DeadlineSource;
  const received = source.receivedAt
    ? isIsoDate(source.receivedAt)
      ? source.receivedAt
      : wall(Date.parse(source.receivedAt), r.time_zone).date
    : null;
  return {
    program: r.program,
    kind: r.kind,
    sourceKind: source.kind,
    receivedOn: received,
    learnedOn: wall(Number(r.created_at_ms), r.time_zone).date,
  };
}

export class NudgeConflictError extends Error {
  override name = "NudgeConflictError";
}

// Nudges for the deadline's current revision, under the conversation
// generation current now. IDs carry both, so neither a moved date nor the
// same letter tracked again after a delete can land on an old nudge. A
// nudge that cannot be created new is an error that rolls the change back.
function scheduleNudges(sql: SqlExec, r: Row, plan: PlannedNudge[], nowMs: number): void {
  const generation = currentGeneration(sql);
  const naming = namingOf(r);
  for (const n of plan) {
    const reminderId = `${NUDGE_PREFIX}${r.id}:g${generation}:${r.revision}:${n.daysBefore}`;
    const made = createReminder(sql, { id: reminderId, text: nudgeText(naming, n.daysBefore, r.due_date), dueAtMs: n.atMs, generation }, nowMs);
    if (!("created" in made) || !made.created) throw new NudgeConflictError(`Nudge ${reminderId} could not be created.`);
    sql.exec(
      "INSERT INTO deadline_nudges(reminder_id, deadline_id, revision, days_before, window_start_ms, window_end_ms, due_date)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
      reminderId, r.id, r.revision, n.daysBefore, n.windowStartMs, n.windowEndMs, r.due_date,
    );
  }
}

// Stops every nudge that has not settled. One handed off and waiting on
// Channels or a retry is withdrawn, so no later run hands it off again.
// One never handed off is cancelled when its deadline closes, and
// withdrawn when a change replaces it, so a cancelled nudge of an open
// deadline is one the person stopped. Returns how many handed off were
// stopped: Channels may already have delivered those.
function stopNudges(sql: SqlExec, deadlineId: string | null, nowMs: number, unsent: "cancelled" | "withdrawn" = "cancelled"): number {
  const scope = deadlineId === null ? "" : " WHERE deadline_id = ?";
  const args = deadlineId === null ? [] : [deadlineId];
  const ours = `id IN (SELECT reminder_id FROM deadline_nudges${scope})`;
  const inFlight = Number(
    (sql.exec(`SELECT COUNT(*) AS n FROM reminders WHERE ${ours} AND status = 'sending'`, ...args).toArray()[0] as { n: number }).n,
  );
  sql.exec(
    "UPDATE reminders SET status = CASE WHEN status = 'sending' THEN 'withdrawn' ELSE ? END, finished_at_ms = ?" +
      ` WHERE ${ours} AND status IN ('scheduled', 'claimed', 'sending')`,
    unsent, nowMs, ...args,
  );
  return inFlight;
}

// What a deadline may become. Anything that changes what a nudge says
// (the date, the program, the kind, the source) bumps the revision and
// replaces the nudges still to come; a new title alone changes no nudge.
interface Next {
  title: string;
  dueDate: string;
  program: string | null;
  kind: DeadlineKind | null;
  sourceJson: string;
  timeZone: string;
}

// The nudges a deadline should have, from its kind and what is stored,
// never from what an earlier kind or version planned. A day handed off
// or cancelled by the person for this date is never planned again, at
// any revision, and a stored nudge for a settled day is not kept. A row stored before nudges kept their due date settles its day
// for every date: it may skip a nudge, never repeat one. The
// same date: the stored nudges not yet sent are kept while their day's
// window is open, at their time or the earliest allowed time from now,
// less a schedule day the kind no longer has; a day the kind has and
// nothing stored covers is added only while its nudge time is ahead, as
// a first plan would have it. A new date: every day whose window is
// still open, at the earliest allowed time from now, and no catch-up.
function reconcile(sql: SqlExec, r: Row, next: Next, nowMs: number, time: NudgeTime): { plan: PlannedNudge[]; changed: boolean } {
  const days = nudgeDays(next.kind);
  // The days settled for this date: handed off, or stopped by the person.
  // A row with no due date of its own settles its day for every date.
  const settled = sql
    .exec(
      "SELECT n.days_before, r.handoffs > 0 AS handed FROM deadline_nudges n JOIN reminders r ON r.id = n.reminder_id" +
        " WHERE n.deadline_id = ? AND (n.due_date = ? OR n.due_date IS NULL) AND (r.handoffs > 0 OR r.status = 'cancelled')",
      r.id, next.dueDate,
    )
    .toArray() as { days_before: number; handed: number }[];
  const blocked = new Set(settled.map((n) => Number(n.days_before)));
  const handedOff = new Set(settled.filter((n) => Number(n.handed)).map((n) => Number(n.days_before)));
  if (next.dueDate !== r.due_date) {
    const plan = planNudges(next.dueDate, next.timeZone, nowMs, time, "rebuild", days).filter((n) => !blocked.has(n.daysBefore));
    return { plan, changed: true };
  }
  const live = (
    sql
      .exec(
        "SELECT n.days_before, n.window_start_ms, n.window_end_ms, r.due_at_ms, r.text FROM deadline_nudges n" +
          " JOIN reminders r ON r.id = n.reminder_id WHERE n.deadline_id = ? AND n.revision = ? AND r.status IN ('scheduled', 'claimed')" +
          " AND n.window_end_ms > ?",
        r.id, r.revision, nowMs,
      )
      .toArray() as { days_before: number; window_start_ms: number; window_end_ms: number; due_at_ms: number; text: string }[]
  ).map((n) => ({ ...n, days_before: Number(n.days_before) }));
  const kept = live.filter((n) => !blocked.has(n.days_before) && (days.includes(n.days_before) || !SCHEDULE_DAYS.has(n.days_before)));
  const missing = days.filter((d) => !blocked.has(d) && !live.some((n) => n.days_before === d));
  const added = planNudges(next.dueDate, next.timeZone, nowMs, time, "ahead", missing);
  const naming = namingOf({ ...r, program: next.program, kind: next.kind, source_json: next.sourceJson });
  const changed =
    JSON.stringify(naming) !== JSON.stringify(namingOf(r)) ||
    kept.length < live.length ||
    added.length > 0 ||
    live.some((n) => n.text !== nudgeText(naming, n.days_before, next.dueDate));
  const plan = [
    ...kept.map((n) => ({
      daysBefore: n.days_before,
      localDate: addDays(next.dueDate, -n.days_before),
      atMs: Math.max(Number(n.due_at_ms), nowMs),
      windowStartMs: Number(n.window_start_ms),
      windowEndMs: Number(n.window_end_ms),
    })),
    ...added,
  ];
  return { plan, changed };
}

function apply(sql: SqlExec, r: Row, next: Next, nowMs: number, time: NudgeTime): DeadlineResult {
  const { plan, changed } = reconcile(sql, r, next, nowMs, time);
  if (!changed) {
    if (next.title === r.title && next.program === r.program && next.sourceJson === r.source_json) {
      return { status: "existing", deadline: view(sql, r) };
    }
    sql.exec(
      "UPDATE deadlines SET title = ?, program = ?, source_json = ?, updated_at_ms = ? WHERE id = ?",
      next.title, next.program, next.sourceJson, nowMs, r.id,
    );
    return { status: "updated", deadline: view(sql, row(sql, r.id)!) };
  }
  const moved = next.dueDate !== r.due_date;
  const nudgesInFlight = stopNudges(sql, r.id, nowMs, "withdrawn");
  sql.exec(
    "UPDATE deadlines SET title = ?, due_date = ?, program = ?, kind = ?, source_json = ?, previous_due_date = ?, time_zone = ?," +
      " revision = revision + 1, updated_at_ms = ? WHERE id = ?",
    next.title, next.dueDate, next.program, next.kind, next.sourceJson, moved ? r.due_date : r.previous_due_date, next.timeZone, nowMs, r.id,
  );
  const updated = row(sql, r.id)!;
  scheduleNudges(sql, updated, plan, nowMs);
  return moved
    ? { status: "moved", deadline: view(sql, updated), moved: { from: r.due_date, to: next.dueDate }, nudgesInFlight }
    : { status: "updated", deadline: view(sql, updated), nudgesInFlight };
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
      "INSERT INTO deadlines(id, idempotency_key, title, due_date, program, kind, source_json, status, revision, time_zone, created_at_ms, updated_at_ms)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)",
      input.id, input.idempotencyKey, input.title, input.dueDate, input.program ?? null, input.kind ?? null,
      JSON.stringify(input.source), input.timeZone, nowMs, nowMs,
    );
    const created = row(sql, input.id)!;
    scheduleNudges(sql, created, planNudges(created.due_date, created.time_zone, nowMs, time, "first", nudgeDays(created.kind)), nowMs);
    return { status: "created", deadline: view(sql, created) };
  }
  if (existing.status !== "open") return { status: "closed", deadline: view(sql, existing) };
  return apply(
    sql,
    existing,
    {
      title: input.title,
      dueDate: input.dueDate,
      program: input.program ?? null,
      kind: input.kind ?? null,
      sourceJson: JSON.stringify(input.source),
      timeZone: input.timeZone,
    },
    nowMs,
    time,
  );
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
  return apply(
    sql,
    r,
    { title: patch.title ?? r.title, dueDate: patch.dueDate ?? r.due_date, program: r.program, kind: r.kind, sourceJson: r.source_json, timeZone },
    nowMs,
    time,
  );
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
// kept, after stopping every nudge removeConversationState left in flight.
export function removeDeadlines(sql: SqlExec, nowMs = Date.now()): number {
  const n = Number((sql.exec("SELECT COUNT(*) AS n FROM deadlines").toArray()[0] as { n: number }).n);
  stopNudges(sql, null, nowMs);
  sql.exec("DELETE FROM deadline_nudges");
  sql.exec("DELETE FROM deadlines");
  return n;
}

// Puts a claimed reminder back to wait until atMs, without spending an
// attempt. One already handed off stays sending.
export function deferReminder(sql: SqlExec, reminderId: string, token: string, atMs: number): void {
  sql.exec(
    "UPDATE reminders SET status = CASE WHEN handoffs = 0 THEN 'scheduled' ELSE status END, next_at_ms = ?," +
      " claim_token = NULL, claimed_at_ms = NULL, attempts = MAX(attempts - 1, 0)" +
      " WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
    atMs, reminderId, token,
  );
}

// The check a delivery run makes on each claimed reminder right before
// its handoff, first sends and retries alike, in the same synchronous
// step as the handoff. null: not a nudge, or a current one inside its
// window, so it goes. withdrawn: its deadline is gone, closed, or at a
// newer revision. deferred: too early, it waits for 9:00 (one already
// handed off stays sending). missed: its day's window closed, so it is
// dropped. The run sends none of these.
export function gateNudge(sql: SqlExec, reminderId: string, token: string, nowMs: number): "withdrawn" | "deferred" | "missed" | null {
  if (!isNudge(reminderId)) return null;
  const w = sql
    .exec(
      "SELECT n.window_start_ms, n.window_end_ms, n.revision, d.status, d.revision AS current_revision" +
        " FROM deadline_nudges n LEFT JOIN deadlines d ON d.id = n.deadline_id WHERE n.reminder_id = ?",
      reminderId,
    )
    .toArray()[0] as
    | { window_start_ms: number; window_end_ms: number; revision: number; status: DeadlineStatus | null; current_revision: number | null }
    | undefined;
  const settle = (status: "withdrawn" | "dropped") =>
    sql.exec(
      "UPDATE reminders SET status = ?, finished_at_ms = ? WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
      status, nowMs, reminderId, token,
    );
  if (!w || w.status !== "open" || Number(w.current_revision) !== Number(w.revision)) {
    settle("withdrawn");
    return "withdrawn";
  }
  if (nowMs >= Number(w.window_start_ms) && nowMs < Number(w.window_end_ms)) return null;
  if (nowMs < Number(w.window_start_ms)) {
    deferReminder(sql, reminderId, token, Number(w.window_start_ms));
    return "deferred";
  }
  settle("dropped");
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
  const one = rest.match(DEADLINE_PATH);
  if (rest !== "/deadlines" && !one) return null;
  try {
    if (rest === "/deadlines") {
      if (method === "GET") return Response.json({ deadlines: await calls.list() });
      if (method !== "POST") return null;
      const input = parseDeadlineInput(await readBody());
      // Every caller names the generation it prepared the deadline under,
      // so a request from before a delete never lands after it.
      if (input.generation === undefined) {
        throw new AgentStateInputError("Body needs the conversation generation it was prepared under.");
      }
      const out = await calls.track(input);
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
