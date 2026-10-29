import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireHandleHash } from "../lib/person.js";
import { getReminderStore } from "../lib/reminder-store.js";
import { newReminderId } from "../lib/reminders.js";
import { parseWhen, validateDue } from "../lib/when.js";

export default defineTool({
  description:
    "Set a reminder the person asked for. Pass their words for when (\"tomorrow at 9\") untouched plus the short reminder text. Times resolve in the person's timezone. Confirm the result in one short sentence afterward.",
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("What to remind them of, in a few words."),
    when: z.string().min(1).max(200).describe("When, in the person's own words."),
  }),
  async execute({ text, when }, ctx) {
    const handleHash = requireHandleHash(ctx);
    const nowMs = Date.now();
    const parsed = parseWhen(when, nowMs);
    if (!parsed) {
      throw new Error(`Could not understand "${when}". Ask for a time like "tomorrow at 9" or "Friday at 2pm".`);
    }
    const invalid = validateDue(parsed.dueAtMs, nowMs);
    if (invalid) throw new Error(invalid);
    const store = await getReminderStore();
    const reminder = {
      id: newReminderId(nowMs, Math.random().toString(16).slice(2, 10)),
      handleHash,
      text: text.trim(),
      dueAtMs: parsed.dueAtMs,
      createdAtMs: nowMs,
      claimedAtMs: null,
      sentAtMs: null,
    };
    await store.save(reminder);
    return { reminderId: reminder.id, dueAt: new Date(parsed.dueAtMs).toISOString(), text: reminder.text };
  },
});
