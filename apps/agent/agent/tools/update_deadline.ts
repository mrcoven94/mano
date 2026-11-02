import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextNudge, parseDueDate } from "../lib/deadlines.js";
import { personEngine, requireTurn } from "../lib/person.js";

export default defineTool({
  description:
    "Change a tracked deadline, or mark it done. Use done when the person says they already sent it, finished it or to stop reminding them because it is handled: its nudges stop. A new date replaces the nudges still to come. List deadlines first when the person names one in words.",
  inputSchema: z.object({
    deadlineId: z.string().min(1),
    due: z.string().min(1).max(60).optional().describe("A new due date in the person's words, or YYYY-MM-DD."),
    title: z.string().min(1).max(120).optional(),
    done: z.boolean().optional().describe("True when it is handled."),
  }),
  async execute(input, ctx) {
    const { turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Deadlines are not available right now. Say so plainly.");
    const patch: { dueDate?: string; title?: string; status?: "done" } = {};
    if (input.done) patch.status = "done";
    else {
      if (input.due) {
        const dueDate = parseDueDate(input.due, turnAtMs);
        if (!dueDate) throw new Error(`Could not read "${input.due}" as a date. Ask for the date like "November 12".`);
        patch.dueDate = dueDate;
      }
      if (input.title) patch.title = input.title.trim();
    }
    if (Object.keys(patch).length === 0) throw new Error("Nothing to change: pass a new date, a title or done.");
    const out = await engine.updateDeadline(input.deadlineId, patch);
    if (!out) return { found: false };
    return {
      found: true,
      status: out.status,
      dueDate: out.deadline.dueDate,
      moved: out.moved ?? null,
      nextNudgeAt: out.deadline.status === "open" ? nextNudge(out.deadline) : null,
      // A nudge already on its way when it closed may still arrive.
      nudgeAlreadySending: (out.nudgesInFlight ?? 0) > 0,
    };
  },
});
