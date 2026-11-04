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
// household size by householdSizeOf (the one rule, in @mano/programs: whom the
// person named or the number they gave, so a letter cannot widen the screen),
// and every income entry with an amount and a frequency: anything missing or
// unsettled is no match, never a guess. A program already on their profile is
// not news.
//
// Each text is a reminder row keyed by generation, state and program, so it
// goes out through the person's one delivery wake-up and Channels' agent-send
// route like a deadline's nudge: Channels refuses it after STOP or on a closed
// conversation, and its key dedupes a re-send. Unlike a nudge it is marked no
// replay: Channels cannot read the flag or the person's hours, so a send the
// provider did not accept is dropped rather than replayed later, and a missed
// text is better than one after they said stop. The row is the record that the
// program was raised: it is never planned again, whatever became of it, and
// after a conversation delete the new generation starts over. A run plans at
// most one text, and none while an earlier one is waiting or one was planned
// or sent today, so three new programs are three days of one text, not three at once.
//
// MANO_DAILY_CHECK_SENDS must be "on" for any of this to reach a person. It
// ships off, because Channels has to understand no replay before Engine sends
// one of these: turn it on in a one-line change to wrangler.toml once both
// Workers carry this code, and set it back to "off" the same way to stop. While
// it is off the check still runs, plans nothing and marks nothing raised, and a
// text already waiting holds, so each program is still told once it is on.
//
// The check runs at the nudge time (MANO_NUDGE_TIME) in the zone of the
// person's state. Right before each handoff the profile is read and the text
// screened again, because it may have waited overnight: with the flag off or
// the match gone it is withdrawn, and otherwise it goes in the words the
// profile supports now. Outside 9:00 to 20:00 local it waits for the next 9:00,
// because unlike a countdown it is just as true tomorrow. Reading the profile
// means waiting on decryption, so the handoff's own step compares the profile
// with the one that was read: if a write landed, the text waits for the next
// run, which reads it again.
//
// Test: test/always-on.test.ts, through the real worker and the Durable Object
// alarm.
import { householdSizeOf, listPrograms, parseProgram, screenIncome } from "@mano/programs";
import { createReminder, currentGeneration, isHelpText } from "./agents/agent-state.js";
import { addDays, deferReminder, localDate, timeZoneForState, zonedInstant, type NudgeTime } from "./deadlines.js";
import { profileRevision, type Frequency, type Profile } from "./profile.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

const WINDOW_OPENS_HOUR = 9;
const WINDOW_CLOSES_HOUR = 20;
const MONTHS_PER_YEAR = 12;
const TIMES_A_MONTH: Record<Frequency, number> = { weekly: 52 / MONTHS_PER_YEAR, biweekly: 26 / MONTHS_PER_YEAR, monthly: 1, yearly: 1 / MONTHS_PER_YEAR };

export { isHelpText };

export function dailyCheckSends(env: { MANO_DAILY_CHECK_SENDS?: string }): boolean {
  return env.MANO_DAILY_CHECK_SENDS === "on";
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
  const householdSize = householdSizeOf(profile);
  if (!state || income === null || householdSize === null) return [];
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

function helpTextId(generation: number, match: HelpMatch): string {
  return `help:g${generation}:${match.key}`;
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
  const earlier = (
    sql.exec("SELECT id, status, created_at_ms, finished_at_ms FROM reminders").toArray() as { id: string; status: string; created_at_ms: number; finished_at_ms: number | null }[]
  ).filter((r) => isHelpText(r.id));
  // Finished counts too: a text held overnight goes the morning after it was planned.
  const busy = earlier.some(
    (r) => ["scheduled", "claimed", "sending"].includes(r.status) || localDate(Number(r.finished_at_ms ?? r.created_at_ms), timeZone) === today,
  );
  if (busy) return null;
  const raised = new Set(earlier.map((r) => r.id));
  for (const match of helpMatches(profile)) {
    const id = helpTextId(generation, match);
    if (raised.has(id)) continue;
    const made = createReminder(sql, { id, text: helpText(match), dueAtMs: nowMs, generation }, nowMs);
    return "created" in made && made.created ? id : null;
  }
  return null;
}

// What the profile says about a text, read before its handoff. text is what
// to send, null when the person turned the check off, the program no longer
// fits or the profile cannot be read. revision names the profile that was read.
export interface HelpStanding {
  text: string | null;
  timeZone: string;
  revision: string;
  sends: boolean;
}

export function standingOf(profile: Profile | null | undefined, reminder: { id: string; generation: number }, revision: string, sends: boolean): HelpStanding {
  const state = profile?.person.address.state?.value;
  const match = profile?.person.alwaysOn?.value === true ? helpMatches(profile).find((m) => helpTextId(reminder.generation, m) === reminder.id) : undefined;
  return { text: match ? helpText(match) : null, timeZone: timeZoneForState(state), revision, sends };
}

// The check a delivery run makes on each claimed text, in the same step as its
// handoff. null: it goes. deferred: the profile changed after it was read, so
// it waits for the next run; sends are off, so it looks again tomorrow; or it
// is outside the person's hours and waits for the next 9:00. withdrawn: it no
// longer stands.
export function gateHelpText(sql: SqlExec, reminderId: string, token: string, nowMs: number, standing: HelpStanding): "withdrawn" | "deferred" | null {
  if (profileRevision(sql) !== standing.revision) {
    deferReminder(sql, reminderId, token, nowMs);
    return "deferred";
  }
  if (standing.text === null) {
    sql.exec(
      "UPDATE reminders SET status = 'withdrawn', finished_at_ms = ? WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
      nowMs, reminderId, token,
    );
    return "withdrawn";
  }
  const today = localDate(nowMs, standing.timeZone);
  const opens = zonedInstant(today, WINDOW_OPENS_HOUR, 0, standing.timeZone);
  if (!standing.sends) {
    deferReminder(sql, reminderId, token, zonedInstant(addDays(today, 1), WINDOW_OPENS_HOUR, 0, standing.timeZone));
    return "deferred";
  }
  if (nowMs >= opens && nowMs < zonedInstant(today, WINDOW_CLOSES_HOUR, 0, standing.timeZone)) return null;
  deferReminder(sql, reminderId, token, nowMs < opens ? opens : zonedInstant(addDays(today, 1), WINDOW_OPENS_HOUR, 0, standing.timeZone));
  return "deferred";
}

// The next nudge time in this zone, strictly after now.
export function nextCheckAt(timeZone: string, nowMs: number, time: NudgeTime): number {
  const today = localDate(nowMs, timeZone);
  const at = zonedInstant(today, time.hour, time.minute, timeZone);
  return at > nowMs ? at : zonedInstant(addDays(today, 1), time.hour, time.minute, timeZone);
}
