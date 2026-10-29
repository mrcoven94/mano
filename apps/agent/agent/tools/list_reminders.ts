import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine } from "../lib/person.js";

export default defineTool({
  description: "List the person's pending reminders, oldest first. Use when they ask what you set or want to change one.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Listing reminders is not available right now. Say so plainly.");
    const reminders = (await engine.listReminders()).filter((r) => r.status === "scheduled");
    return { reminders: reminders.map((r) => ({ reminderId: r.id, text: r.text, dueAt: r.dueAt })) };
  },
});
