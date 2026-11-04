import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextNudge, personDeadlineKey, resolveDueDate } from "../lib/deadlines.js";
import { DEADLINE_KINDS } from "../lib/engine.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { profileTimeZone } from "../lib/profile.js";

export default defineTool({
  description:
    "Track a deadline the person tells you about, such as a renewal or a form due by a date. Deadlines in letters Mano reads are tracked already; do not add those again. Mano then texts the person 14, 7 and 2 days before and on the day, offering to start it; for an interview or hearing, the day before instead of 2 days before. Pass due as YYYY-MM-DD only, worked out from today's date; when a numeric date the person wrote could mean two days (4/3/2027), ask which before calling. A person saying a date has already gone by (\"it was due last week\") needs no deadline: do not call this, say plainly it has passed and ask if the office gave a new date. Pass a short title naming the task (\"CalFresh renewal\"). Set kind only when it is clearly one of the listed kinds; the text Mano sends names the action only from kind. If the answer's status is ask, nothing was saved: ask the person its question. Set yearConfirmed true only on the call after the person answered that question; it saves the date exactly as given. Confirm the saved dueDate in one short sentence, always with its year. If the answer has a note, follow it.",
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe("What is due, as a short noun phrase: \"CalFresh renewal\"."),
    due: z.string().min(1).max(60).describe("The due date, YYYY-MM-DD."),
    yearConfirmed: z.boolean().optional().describe("True only after the person answered Mano's question about this date's year."),
    program: z.string().min(1).max(80).optional().describe("The program, when it is clear: \"CalFresh\"."),
    kind: z.enum(DEADLINE_KINDS).optional().describe("What is due, when it is clear."),
  }),
  async execute(input, ctx) {
    const { turnId, turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Tracking deadlines is not available right now. Say so plainly and do not promise it.");
    const timeZone = await profileTimeZone(engine);
    const due = resolveDueDate(input.due, turnAtMs, timeZone, input.yearConfirmed);
    if (due.status === "ask") return due;
    const dueDate = due.date;
    const out = await engine.trackDeadline({
      title: input.title.trim(),
      dueDate,
      ...(input.program ? { program: input.program.trim() } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      idempotencyKey: personDeadlineKey(turnId, dueDate, input.title),
    });
    if (!out) throw new Error("Tracking deadlines is not available right now. Say so plainly and do not promise it.");
    const firstNudgeAt = nextNudge(out.deadline);
    const notes = [due.note, firstNudgeAt || out.deadline.status !== "open" ? null : "This date's reminder times have passed, so no reminder will go out. Say so plainly."].filter(Boolean);
    return {
      deadlineId: out.deadline.id,
      title: out.deadline.title,
      dueDate: out.deadline.dueDate,
      status: out.status,
      firstNudgeAt,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  },
});
