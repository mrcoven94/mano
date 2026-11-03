import { defineTool } from "eve/tools";
import { z } from "zod";

import type { EngineReminder } from "../lib/engine.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { profileTimeZone } from "../lib/profile.js";
import { REMINDER_PREFIX, placeClaimId, reminderBase, reminderIdAt, sameWords } from "../lib/reminders.js";
import { parseWhen, validateDue } from "../lib/when.js";

// Different reminders for the same time from one message.
const MAX_SAME_TIME = 10;

// Every answer goes through here: the tool never reports a reminder whose
// words differ from the ones asked for as if it were that one.
function answer(reminder: EngineReminder, text: string) {
  if (!sameWords(reminder.text, text)) throw new Error("Setting that reminder failed. Ask the person to try again.");
  return { reminderId: reminder.id, dueAt: reminder.dueAt, text: reminder.text.replace(REMINDER_PREFIX, "") };
}

export default defineTool({
  description:
    "Set one reminder the person asked for. Pass their words for when (\"tomorrow at 9\") untouched plus the short reminder text. Days and clock times are read in the time zone of the state on the person's profile, or Pacific time when no state is on file. For several reminders, call it once per reminder. Confirm the result in one short sentence afterward.",
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("What to remind them of, in a few words."),
    when: z.string().min(1).max(200).describe("When, in the person's own words."),
  }),
  async execute(input, ctx) {
    const { when } = input;
    const { turnId, turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Setting reminders is not available right now. Say so plainly and do not promise it.");
    const parsed = parseWhen(when, turnAtMs, await profileTimeZone(engine));
    if (!parsed) {
      throw new Error(`Could not understand "${when}". Ask for a time like "tomorrow at 9" or "Friday at 2pm".`);
    }
    const base = reminderBase(turnId, parsed.asked);
    const text = `${REMINDER_PREFIX}${input.text.trim()}`;
    const attempt = ctx.session.turn?.id ?? "attempt";
    const receivedAt = new Date(turnAtMs).toISOString();
    const invalid = validateDue(parsed.dueAtMs, turnAtMs);
    if (invalid) {
      // A retry finds what an earlier attempt saved before it judges the
      // time again: one that reads a later zone can work out a time that
      // has passed for a reminder already set. Only this same reminder
      // counts, its text exactly as Engine compares content; another one
      // for the same time is never returned. Its place is claimed for this
      // attempt, so the next reminder for that time takes the next place,
      // and creating it again with its stored content re-arms a wake-up
      // the first attempt may have lost.
      const kept = (await engine.listReminders()).find((r) => (r.id === base || r.id.startsWith(`${base}-`)) && r.text === text);
      const place = kept ? Array.from({ length: MAX_SAME_TIME }, (_, i) => i).find((i) => reminderIdAt(base, i) === kept.id) : undefined;
      if (!kept || place === undefined) throw new Error(invalid);
      const [, again] = await Promise.all([
        engine.putTurn(placeClaimId(base, attempt, place), receivedAt),
        engine.createReminder({ id: kept.id, text: kept.text, dueAt: kept.dueAt }),
      ]);
      return answer(again, text);
    }
    let saved: EngineReminder | null = null;
    for (let place = 0; place < MAX_SAME_TIME && !saved; place++) {
      const id = reminderIdAt(base, place);
      const claim = await engine.putTurn(placeClaimId(base, attempt, place), receivedAt);
      // A place this attempt claims can still hold an earlier attempt's
      // reminder. With these words it is this one; with other words it is
      // another reminder for the same time, so this one takes the next place.
      const there = claim.created
        ? await engine.createReminder({ id, text, dueAt: new Date(parsed.dueAtMs).toISOString() })
        : // Another call of this attempt holds this place. It is this same
          // call only when Eve re-ran its step: then the reminder there has
          // these words.
          (await engine.listReminders()).find((r) => r.id === id);
      if (there && sameWords(there.text, text)) saved = there;
    }
    if (!saved) throw new Error("Too many reminders at the same time in one message. Ask the person to set them one by one.");
    return answer(saved, text);
  },
});
