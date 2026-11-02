import { defineTool } from "eve/tools";
import { z } from "zod";

import { personEngine } from "../lib/person.js";

export default defineTool({
  description:
    "Stop tracking a deadline that does not apply (a wrong date, not theirs). If it is handled, mark it done with update_deadline instead. Its nudges stop. List deadlines first when the person names one in words.",
  inputSchema: z.object({ deadlineId: z.string().min(1) }),
  async execute({ deadlineId }, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Deadlines are not available right now. Say so plainly.");
    const out = await engine.cancelDeadline(deadlineId);
    if (!out) return { found: false };
    return { found: true, status: out.status, nudgeAlreadySending: (out.nudgesInFlight ?? 0) > 0 };
  },
});
