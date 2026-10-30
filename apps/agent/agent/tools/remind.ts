import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine, requireTurn } from "../lib/person.js";
import { REMINDER_PREFIX, ordinalInTurn, reminderIdFor } from "../lib/reminders.js";
import { parseWhen, validateDue } from "../lib/when.js";

export default defineTool({
  description:
    "Set one reminder the person asked for. Pass their words for when (\"tomorrow at 9\") untouched plus the short reminder text. Times resolve in the person's timezone. For several reminders, call it once per reminder and wait for each result before the next. Confirm the result in one short sentence afterward.",
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("What to remind them of, in a few words."),
    when: z.string().min(1).max(200).describe("When, in the person's own words."),
  }),
  async execute({ text, when }, ctx) {
    const { turnId, turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Setting reminders is not available right now. Say so plainly and do not promise it.");
    const parsed = parseWhen(when, turnAtMs);
    if (!parsed) {
      throw new Error(`Could not understand "${when}". Ask for a time like "tomorrow at 9" or "Friday at 2pm".`);
    }
    const invalid = validateDue(parsed.dueAtMs, turnAtMs);
    if (invalid) throw new Error(invalid);
    const saved = await engine.createReminder({
      id: reminderIdFor(turnId, ordinalInTurn(ctx.messages ?? [], ctx.toolName ?? "remind")),
      // Engine delivers this text as is, so it says what it is.
      text: `${REMINDER_PREFIX}${text.trim()}`,
      dueAt: new Date(parsed.dueAtMs).toISOString(),
    });
    return { reminderId: saved.id, dueAt: saved.dueAt, text: saved.text.replace(REMINDER_PREFIX, "") };
  },
});
