import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireHandleHash } from "../lib/person.js";
import { getReminderStore } from "../lib/reminder-store.js";
import { StorageUnavailable } from "../lib/storage.js";

export default defineTool({
  description: "List the person's pending reminders, oldest first. Use when they ask what you set or want to change one.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const handleHash = requireHandleHash(ctx);
    const store = await getReminderStore();
    if (!store) throw new StorageUnavailable("Listing reminders");
    const reminders = await store.listForHandle(handleHash);
    return {
      reminders: reminders.map((r) => ({ reminderId: r.id, text: r.text, dueAt: new Date(r.dueAtMs).toISOString() })),
    };
  },
});
