import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireTurn } from "../lib/person.js";
import { getReminderStore } from "../lib/reminder-store.js";
import { reminderIdFor } from "../lib/reminders.js";
import { StorageUnavailable } from "../lib/storage.js";
import { parseWhen, validateDue } from "../lib/when.js";

export default defineTool({
  description:
    "Set a reminder the person asked for. Pass their words for when (\"tomorrow at 9\") untouched plus the short reminder text. Times resolve in the person's timezone. Confirm the result in one short sentence afterward.",
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("What to remind them of, in a few words."),
    when: z.string().min(1).max(200).describe("When, in the person's own words."),
  }),
  async execute({ text, when }, ctx) {
    const { handleHash, turnId, turnAtMs, generation } = requireTurn(ctx);
    const store = await getReminderStore();
    if (!store) throw new StorageUnavailable("Setting reminders");
    const parsed = parseWhen(when, turnAtMs);
    if (!parsed) {
      throw new Error(`Could not understand "${when}". Ask for a time like "tomorrow at 9" or "Friday at 2pm".`);
    }
    const invalid = validateDue(parsed.dueAtMs, turnAtMs);
    if (invalid) throw new Error(invalid);
    const saved = await store.create({
      id: reminderIdFor(turnId, parsed.dueAtMs, text),
      handleHash,
      generation,
      text: text.trim(),
      dueAtMs: parsed.dueAtMs,
      createdAtMs: turnAtMs,
      claimedAtMs: null,
      sentAtMs: null,
    });
    return { reminderId: saved.id, dueAt: new Date(saved.dueAtMs).toISOString(), text: saved.text };
  },
});
