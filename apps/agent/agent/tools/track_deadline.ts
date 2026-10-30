import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextNudge, parseDueDate, personDeadlineKey } from "../lib/deadlines.js";
import { DEADLINE_KINDS } from "../lib/engine.js";
import { personEngine, requireTurn } from "../lib/person.js";

export default defineTool({
  description:
    "Track a deadline the person tells you about, such as a renewal or a form due by a date. Deadlines in letters Mano reads are tracked already; do not add those again. Mano then texts the person 14, 7 and 2 days before and on the day, offering to start it. Pass the due date in their words (\"November 12\", \"11/12\") or as YYYY-MM-DD, and a short title naming the task (\"CalFresh renewal\"). Set kind only when it is clearly one of the listed kinds; the text Mano sends names the action only from kind. Confirm the date back in one short sentence.",
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe("What is due, as a short noun phrase: \"CalFresh renewal\"."),
    due: z.string().min(1).max(60).describe("The due date in the person's words, or YYYY-MM-DD."),
    program: z.string().min(1).max(80).optional().describe("The program, when it is clear: \"CalFresh\"."),
    kind: z.enum(DEADLINE_KINDS).optional().describe("What is due, when it is clear."),
  }),
  async execute(input, ctx) {
    const { turnId, turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Tracking deadlines is not available right now. Say so plainly and do not promise it.");
    const dueDate = parseDueDate(input.due, turnAtMs);
    if (!dueDate) throw new Error(`Could not read "${input.due}" as a date. Ask for the date like "November 12".`);
    const out = await engine.trackDeadline({
      title: input.title.trim(),
      dueDate,
      ...(input.program ? { program: input.program.trim() } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      idempotencyKey: personDeadlineKey(turnId, dueDate, input.title),
    });
    if (!out) throw new Error("Tracking deadlines is not available right now. Say so plainly and do not promise it.");
    return {
      deadlineId: out.deadline.id,
      title: out.deadline.title,
      dueDate: out.deadline.dueDate,
      status: out.status,
      firstNudgeAt: nextNudge(out.deadline),
    };
  },
});
