import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireHandleHash } from "../lib/person.js";
import { getReminderStore } from "../lib/reminder-store.js";

export default defineTool({
  description: "Cancel one pending reminder by its ID. List reminders first when the person names one by words instead.",
  inputSchema: z.object({ reminderId: z.string().min(1) }),
  async execute({ reminderId }, ctx) {
    const handleHash = requireHandleHash(ctx);
    const store = await getReminderStore();
    const cancelled = await store.cancel(reminderId, handleHash);
    return { cancelled };
  },
});
