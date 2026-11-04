import { defineTool } from "eve/tools";
import { z } from "zod";

import { NO_REMINDER, nextNudge, resolveDueDate } from "../lib/deadlines.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { profileTimeZone } from "../lib/profile.js";

export default defineTool({
  description:
    "Change a tracked deadline, or mark it done. Use done when the person says they already sent it, finished it or to stop reminding them because it is handled: its nudges stop. A new date replaces the nudges still to come. Pass it as YYYY-MM-DD only, worked out from today's date; when a numeric date the person wrote could mean two days (4/3/2027), ask which before calling. If the answer's status is ask, nothing changed: ask the person its question. Set yearConfirmed true only on the call after the person answered that question; it saves the date exactly as given. Say the new date with its year. If the answer has a note, follow it. List deadlines first when the person names one in words.",
  inputSchema: z.object({
    deadlineId: z.string().min(1),
    due: z.string().min(1).max(60).optional().describe("A new due date, YYYY-MM-DD."),
    yearConfirmed: z.boolean().optional().describe("True only after the person answered Mano's question about this date's year."),
    title: z.string().min(1).max(120).optional(),
    done: z.boolean().optional().describe("True when it is handled."),
  }),
  async execute(input, ctx) {
    const { turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Deadlines are not available right now. Say so plainly.");
    const patch: { dueDate?: string; title?: string; status?: "done" } = {};
    let note: string | null = null;
    if (input.done) patch.status = "done";
    else {
      if (input.due) {
        const due = resolveDueDate(input.due, turnAtMs, await profileTimeZone(engine), input.yearConfirmed);
        if (due.status === "ask") return due;
        patch.dueDate = due.date;
        note = due.note;
      }
      if (input.title) patch.title = input.title.trim();
    }
    if (Object.keys(patch).length === 0) throw new Error("Nothing to change: pass a new date, a title or done.");
    const out = await engine.updateDeadline(input.deadlineId, patch);
    if (!out) return { found: false };
    const nextNudgeAt = out.deadline.status === "open" ? nextNudge(out.deadline) : null;
    const notes = [note, patch.dueDate && out.deadline.status === "open" && !nextNudgeAt ? NO_REMINDER : null].filter(Boolean);
    return {
      found: true,
      status: out.status,
      dueDate: out.deadline.dueDate,
      moved: out.moved ?? null,
      nextNudgeAt,
      // A nudge already on its way when it closed may still arrive.
      nudgeAlreadySending: (out.nudgesInFlight ?? 0) > 0,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  },
});
