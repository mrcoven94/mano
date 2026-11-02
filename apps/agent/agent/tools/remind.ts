import { defineTool } from "eve/tools";
import { z } from "zod";

import type { EngineReminder } from "../lib/engine.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { REMINDER_PREFIX, placeClaimId, reminderBase, reminderIdAt, sameWords } from "../lib/reminders.js";
import { parseWhen, validateDue } from "../lib/when.js";

// Different reminders for the same time from one message.
const MAX_SAME_TIME = 10;

export default defineTool({
  description:
    "Set one reminder the person asked for. Pass their words for when (\"tomorrow at 9\") untouched plus the short reminder text. Times resolve in the person's timezone. For several reminders, call it once per reminder. Confirm the result in one short sentence afterward.",
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("What to remind them of, in a few words."),
    when: z.string().min(1).max(200).describe("When, in the person's own words."),
  }),
  async execute(input, ctx) {
    const { when } = input;
    const { turnId, turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Setting reminders is not available right now. Say so plainly and do not promise it.");
    const parsed = parseWhen(when, turnAtMs);
    if (!parsed) {
      throw new Error(`Could not understand "${when}". Ask for a time like "tomorrow at 9" or "Friday at 2pm".`);
    }
    const invalid = validateDue(parsed.dueAtMs, turnAtMs);
    if (invalid) throw new Error(invalid);
    const base = reminderBase(turnId, parsed.dueAtMs);
    const attempt = ctx.session.turn?.id ?? "attempt";
    const text = `${REMINDER_PREFIX}${input.text.trim()}`;
    const receivedAt = new Date(turnAtMs).toISOString();
    let saved: EngineReminder | null = null;
    for (let place = 0; place < MAX_SAME_TIME && !saved; place++) {
      const id = reminderIdAt(base, place);
      const claim = await engine.putTurn(placeClaimId(base, attempt, place), receivedAt);
      if (claim.created) {
        saved = await engine.createReminder({ id, text, dueAt: new Date(parsed.dueAtMs).toISOString() });
        break;
      }
      // Another call of this attempt holds this place. It is this same
      // call only when Eve re-ran its step: then the reminder there has
      // these words.
      const there = (await engine.listReminders()).find((r) => r.id === id);
      if (there && sameWords(there.text, text)) saved = there;
    }
    if (!saved) throw new Error("Too many reminders at the same time in one message. Ask the person to set them one by one.");
    return { reminderId: saved.id, dueAt: saved.dueAt, text: saved.text.replace(REMINDER_PREFIX, "") };
  },
});
