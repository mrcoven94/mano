import { defineTool } from "eve/tools";
import { z } from "zod";

import { daysLeft, lastNudge, nextNudge } from "../lib/deadlines.js";
import { personEngine } from "../lib/person.js";

export default defineTool({
  description:
    "List the deadlines Mano is tracking for the person, soonest first, with days left, the next nudge and the last one Mano texted. Use for \"what's coming up?\" and before changing or closing one the person names in words.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Deadlines are not available right now. Say so plainly.");
    const deadlines = await engine.listDeadlines();
    if (!deadlines) throw new Error("Deadlines are not available right now. Say so plainly and do not guess any.");
    const now = Date.now();
    return {
      deadlines: deadlines
        .filter((d) => d.status === "open")
        .map((d) => ({
          deadlineId: d.id,
          title: d.title,
          dueDate: d.dueDate,
          daysLeft: daysLeft(d, now),
          nextNudgeAt: nextNudge(d),
          lastNudge: lastNudge(d),
        })),
    };
  },
});
