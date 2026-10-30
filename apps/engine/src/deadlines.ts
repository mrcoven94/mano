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
// after a crash. Before every handoff, retries included, a nudge is
// checked against its deadline: one whose deadline closed, moved or was
// deleted is withdrawn, never sent. It also only goes inside 9:00 to
// 20:00 local on its own day; earlier it waits, later it is dropped, so a
// count like "in 7 days" is never sent on the wrong day.
//
// A nudge never carries a letter's own words. It names the action only
// from the explicit kind (renewal, recertification, interview, hearing,
// appeal, payment, documents) and the program only when it is a known
// one: "Your CalFresh renewal is due in 12 days". With no kind it names
// no action: "Your CalFresh deadline is in 12 days", or "The deadline
// from the letter you sent on October 27" by the day the letter arrived.
// The title is kept only for the agent, quoted as data. A nudge with a
// kind asks ("Want me to start it?"); acting still needs the person's
// yes on an approval.
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
// Tests: test-node/deadlines.test.ts (SQLite) and test/deadlines-routes.test.ts (worker, alarm).
import {
  AgentStateInputError,
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

// The program names a nudge may use. Replaced by the Programs catalog
// once it lands.
const KNOWN_PROGRAMS = [
  "CalFresh", "SNAP", "Medi-Cal", "Medicaid", "Medicare", "WIC", "TANF", "CalWORKs", "SSI", "SSDI", "LIHEAP",
  "Section 8", "CHIP", "Covered California", "General Assistance",
];
export const DEADLINE_KINDS = ["renewal", "recertification", "interview", "hearing", "appeal", "payment", "documents"] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

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

function monthDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function knownProgram(program: string | null): string | null {
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
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
  const cleaned = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
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
  if (s.receivedAt !== undefined) {
    if (typeof s.receivedAt !== "string" || !(isIsoDate(s.receivedAt) || /^\d{4}-\d{2}-\d{2}T/.test(s.receivedAt)) || !Number.isFinite(Date.parse(s.receivedAt))) {
      throw new AgentStateInputError("source.receivedAt must be YYYY-MM-DD or an ISO timestamp.");
    }
    source.receivedAt = s.receivedAt;
  }
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
  kind: DeadlineKind | null;
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
  const rows = sql.exec("SELECT * FROM deadlines ORDER BY status != 'open', due_date, id").toArray() as Row[];
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
function scheduleNudges(sql: SqlExec, r: Row, nowMs: number, time: NudgeTime): void {
  const generation = currentGeneration(sql);
  const naming = namingOf(r);
  for (const n of planNudges(r.due_date, r.time_zone, nowMs, time)) {
    const reminderId = `${NUDGE_PREFIX}${r.id}:g${generation}:${r.revision}:${n.daysBefore}`;
    const made = createReminder(sql, { id: reminderId, text: nudgeText(naming, n.daysBefore, r.due_date), dueAtMs: n.atMs, generation }, nowMs);
    if (!("created" in made) || !made.created) throw new NudgeConflictError(`Nudge ${reminderId} could not be created.`);
    sql.exec(
      "INSERT INTO deadline_nudges(reminder_id, deadline_id, revision, days_before, window_start_ms, window_end_ms) VALUES (?, ?, ?, ?, ?, ?)",
      reminderId, r.id, r.revision, n.daysBefore, n.windowStartMs, n.windowEndMs,
    );
  }
}

// Stops every nudge that has not settled: one never handed off is
// cancelled, one handed off and waiting on Channels or a retry is
// withdrawn, so no later run hands it off again. Returns how many were
// withdrawn: Channels may already have delivered those.
function stopNudges(sql: SqlExec, deadlineId: string | null, nowMs: number): number {
  const scope = deadlineId === null ? "" : " WHERE deadline_id = ?";
  const args = deadlineId === null ? [] : [deadlineId];
  const ours = `id IN (SELECT reminder_id FROM deadline_nudges${scope})`;
  const inFlight = Number(
    (sql.exec(`SELECT COUNT(*) AS n FROM reminders WHERE ${ours} AND status = 'sending'`, ...args).toArray()[0] as { n: number }).n,
  );
  sql.exec(
    "UPDATE reminders SET status = CASE WHEN status = 'sending' THEN 'withdrawn' ELSE 'cancelled' END, finished_at_ms = ?" +
      ` WHERE ${ours} AND status IN ('scheduled', 'claimed', 'sending')`,
    nowMs, ...args,
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

function apply(sql: SqlExec, r: Row, next: Next, nowMs: number, time: NudgeTime): DeadlineResult {
  const sameNudges =
    next.dueDate === r.due_date &&
    JSON.stringify(namingOf({ ...r, program: next.program, kind: next.kind, source_json: next.sourceJson })) === JSON.stringify(namingOf(r));
  if (sameNudges) {
    if (next.title === r.title && next.program === r.program && next.sourceJson === r.source_json) {
      return { status: "existing", deadline: view(sql, r) };
    }
    sql.exec(
      "UPDATE deadlines SET title = ?, program = ?, source_json = ?, updated_at_ms = ? WHERE id = ?",
      next.title, next.program, next.sourceJson, nowMs, r.id,
    );
    return { status: "updated", deadline: view(sql, row(sql, r.id)!) };
  }
  const nudgesInFlight = stopNudges(sql, r.id, nowMs);
  const moved = next.dueDate !== r.due_date;
  sql.exec(
    "UPDATE deadlines SET title = ?, due_date = ?, program = ?, kind = ?, source_json = ?, previous_due_date = ?, time_zone = ?," +
      " revision = revision + 1, updated_at_ms = ? WHERE id = ?",
    next.title, next.dueDate, next.program, next.kind, next.sourceJson, moved ? r.due_date : r.previous_due_date, next.timeZone, nowMs, r.id,
  );
  const updated = row(sql, r.id)!;
  scheduleNudges(sql, updated, nowMs, time);
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
    scheduleNudges(sql, created, nowMs, time);
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
    sql.exec(
      "UPDATE reminders SET status = CASE WHEN handoffs = 0 THEN 'scheduled' ELSE status END, next_at_ms = ?," +
        " claim_token = NULL, claimed_at_ms = NULL, attempts = MAX(attempts - 1, 0)" +
        " WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
      Number(w.window_start_ms), reminderId, token,
    );
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
  const one = rest.match(/^\/deadlines\/([^/]+)$/);
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
