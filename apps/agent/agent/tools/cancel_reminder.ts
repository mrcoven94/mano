import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireHandleHash } from "../lib/person.js";
import { getReminderStore } from "../lib/reminder-store.js";
import { StorageUnavailable } from "../lib/storage.js";

export default defineTool({
  description: "Cancel one pending reminder by its ID. List reminders first when the person names one by words instead.",
  inputSchema: z.object({ reminderId: z.string().min(1) }),
  async execute({ reminderId }, ctx) {
    const handleHash = requireHandleHash(ctx);
    const store = await getReminderStore();
    if (!store) throw new StorageUnavailable("Cancelling reminders");
    const outcome = await store.cancel(reminderId, handleHash);
    // "sending" means it may already be on its way: say so, never that it
    // was cancelled.
    return { cancelled: outcome === "cancelled", alreadySending: outcome === "sending", found: outcome !== "not_found" };
  },
});
