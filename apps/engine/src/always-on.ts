// The daily check: once a day, for a person who turned it on, Mano compares
// their profile with the program catalog and texts them about one program
// they may qualify for that it has not told them about yet. Plain rules
// only, no model call: the person's state picks the programs, and
// screenIncome from @mano/programs compares what they said about their
// household and income with the published gross limits. The catalog covers
// eight states; anywhere else there is nothing to match, so nothing is sent.
//
// The catalog never proves anyone qualifies (the agency decides), so the
// text only ever says "may" and what to check. A match needs the state, the
// person's own word on who lives with them, and every income entry with an
// amount and a frequency: anything missing or unsettled is no match, never a
// guess. A program already on their profile is not news.
//
// Each text is a reminder row keyed by generation, state and program, so it
// goes out through the person's one delivery wake-up and Channels' agent-send
// route like a deadline's nudge: Channels refuses it after STOP or on a closed
// conversation, and its key dedupes a re-send. The row is the record that the
// program was raised: it is never planned again, whatever became of it, and
// after a conversation delete the new generation starts over. A run plans at
// most one text, and none while an earlier one is waiting or one was planned
// or sent today, so three new programs are three days of one text, not three at once.
//
// The check runs at the nudge time (MANO_NUDGE_TIME) in the zone of the
// person's state. Right before each handoff the text is checked again: with
// the flag off it is withdrawn, and outside 9:00 to 20:00 local it waits for
// the next 9:00, because unlike a countdown it is just as true tomorrow.
//
// Test: test/always-on.test.ts, through the real worker and the Durable Object
// alarm.
import { listPrograms, parseProgram, screenIncome } from "@mano/programs";
import { createReminder, currentGeneration } from "./agents/agent-state.js";
import { addDays, deferReminder, localDate, zonedInstant, type NudgeTime } from "./deadlines.js";
import type { Frequency, Profile } from "./profile.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

const HELP_PREFIX = "help:";
const WINDOW_OPENS_HOUR = 9;
const WINDOW_CLOSES_HOUR = 20;
const MONTHS_PER_YEAR = 12;
const TIMES_A_MONTH: Record<Frequency, number> = { weekly: 52 / MONTHS_PER_YEAR, biweekly: 26 / MONTHS_PER_YEAR, monthly: 1, yearly: 1 / MONTHS_PER_YEAR };

export function isHelpText(reminderId: string): boolean {
  return reminderId.startsWith(HELP_PREFIX);
}

export interface HelpMatch {
  // State and program: the same program in another state is new.
  key: string;
  name: string;
  householdSize: number;
}

// Null when an entry does not say how much or how often, or nothing is on
// file: no income on file is not the same as no income.
function monthlyIncome(profile: Profile): number | null {
  if (profile.income.length === 0) return null;
  let total = 0;
  for (const entry of profile.income) {
    if (!entry.amount || !entry.frequency) return null;
    total += entry.amount.value * TIMES_A_MONTH[entry.frequency.value];
  }
  return total;
}

// Every catalog program this profile may qualify for and does not already
// have, in catalog order.
export function helpMatches(profile: Profile): HelpMatch[] {
  const state = profile.person.address.state?.value;
  const income = monthlyIncome(profile);
  if (!state || income === null || profile.person.householdConfirmed?.value !== true) return [];
  const householdSize = 1 + profile.household.length;
  const matches: HelpMatch[] = [];
  for (const entry of listPrograms(state)) {
    if (!entry.name) continue;
    const onFile = profile.programs.some(
      (p) => p.program && parseProgram(p.program.value, entry.state) === entry.program && (!p.state || p.state.value === entry.state),
    );
    if (onFile) continue;
    if (screenIncome(entry, { householdSize, monthlyIncome: income }).result !== "may_qualify") continue;
    matches.push({ key: `${entry.state}:${entry.program}`, name: entry.name.value, householdSize });
  }
  return matches;
}

export function helpText(match: HelpMatch): string {
  return (
    `Mano's daily check found something new: you may qualify for ${match.name}. ` +
    `Your income on file looks at or under its limit for a household of ${match.householdSize}, but the office decides. ` +
    `Check that your income and household are still right. Want me to go through it with you? ` +
    `Text "stop checking" to turn this off, or STOP to end all texts.`
  );
}

// The next text this person should get, as a reminder row due now, or null.
// One statement per row, fenced on the generation the profile was read under,
// so a repeated run and a run racing a delete both write nothing.
export function planHelpText(sql: SqlExec, profile: Profile, generation: number, timeZone: string, nowMs: number): string | null {
  if (generation !== currentGeneration(sql)) return null;
  const today = localDate(nowMs, timeZone);
  const earlier = sql
    .exec("SELECT id, status, created_at_ms, finished_at_ms FROM reminders WHERE substr(id, 1, ?) = ?", HELP_PREFIX.length, HELP_PREFIX)
    .toArray() as { id: string; status: string; created_at_ms: number; finished_at_ms: number | null }[];
  // Finished counts too: a text held overnight goes the morning after it was planned.
  const busy = earlier.some(
    (r) => ["scheduled", "claimed", "sending"].includes(r.status) || localDate(Number(r.finished_at_ms ?? r.created_at_ms), timeZone) === today,
  );
  if (busy) return null;
  const raised = new Set(earlier.map((r) => r.id));
  for (const match of helpMatches(profile)) {
    const id = `${HELP_PREFIX}g${generation}:${match.key}`;
    if (raised.has(id)) continue;
    const made = createReminder(sql, { id, text: helpText(match), dueAtMs: nowMs, generation }, nowMs);
    return "created" in made && made.created ? id : null;
  }
  return null;
}

// The check a delivery run makes on each claimed text right before its
// handoff, in the same step. null: it goes. withdrawn: the person turned the
// check off. deferred: outside the person's hours, it waits for the next 9:00.
export function gateHelpText(
  sql: SqlExec,
  reminderId: string,
  token: string,
  nowMs: number,
  setting: { on: boolean; timeZone: string },
): "withdrawn" | "deferred" | null {
  if (!setting.on) {
    sql.exec(
      "UPDATE reminders SET status = 'withdrawn', finished_at_ms = ? WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
      nowMs, reminderId, token,
    );
    return "withdrawn";
  }
  const today = localDate(nowMs, setting.timeZone);
  const opens = zonedInstant(today, WINDOW_OPENS_HOUR, 0, setting.timeZone);
  if (nowMs >= opens && nowMs < zonedInstant(today, WINDOW_CLOSES_HOUR, 0, setting.timeZone)) return null;
  deferReminder(sql, reminderId, token, nowMs < opens ? opens : zonedInstant(addDays(today, 1), WINDOW_OPENS_HOUR, 0, setting.timeZone));
  return "deferred";
}

// The next nudge time in this zone, strictly after now.
export function nextCheckAt(timeZone: string, nowMs: number, time: NudgeTime): number {
  const today = localDate(nowMs, timeZone);
  const at = zonedInstant(today, time.hour, time.minute, timeZone);
  return at > nowMs ? at : zonedInstant(addDays(today, 1), time.hour, time.minute, timeZone);
}
