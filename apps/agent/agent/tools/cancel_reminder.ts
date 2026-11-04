import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine } from "../lib/person.js";

export default defineTool({
  description: "Cancel one pending reminder by its ID. List reminders first when the person names one by words instead.",
  inputSchema: z.object({ reminderId: z.string().min(1) }),
  async execute({ reminderId }, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Cancelling reminders is not available right now. Say so plainly.");
    const out = await engine.cancelReminder(reminderId);
    if (!out) return { cancelled: false, found: false };
    // A reminder already claimed for delivery may be on its way: say so,
    // never that it was cancelled.
    const alreadySending = !out.cancelled && (out.reminder.status === "sending" || out.reminder.status === "sent");
    return { cancelled: out.cancelled, alreadySending, found: true };
  },
});
