import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextNudge, personDeadlineKey } from "../lib/deadlines.js";
import { notWritten, resolveDueDate, whatWasSaid } from "../lib/due-date.js";
import { DEADLINE_KINDS } from "../lib/engine.js";
import { personEngine, requireTurn } from "../lib/person.js";
import { profileTimeZone } from "../lib/profile.js";

export default defineTool({
  description:
    "Track a deadline the person tells you about, such as a renewal or a form due by a date. Deadlines in letters Mano reads are tracked already; do not add those again. Mano then texts the person 14, 7 and 2 days before and on the day, offering to start it; for an interview or hearing, the day before instead of 2 days before. Pass the due date in their words (\"November 12\", \"11/12\"), with a year only if they gave one: Mano works out the year itself and answers with the date it saved. Do not call this for a date they say has already gone by (\"it was due last week\"); say plainly it has passed and ask if the office gave a new date. Pass a short title naming the task (\"CalFresh renewal\"). Set kind only when it is clearly one of the listed kinds; the text Mano sends names the action only from kind. Confirm the date from the answer in one short sentence. If the answer has a tell or a note, follow it.",
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe("What is due, as a short noun phrase: \"CalFresh renewal\"."),
    due: z.string().min(1).max(60).describe("The due date in the person's words, with a year only if they gave one."),
    program: z.string().min(1).max(80).optional().describe("The program, when it is clear: \"CalFresh\"."),
    kind: z.enum(DEADLINE_KINDS).optional().describe("What is due, when it is clear."),
  }),
  async execute(input, ctx) {
    const { turnId, turnAtMs } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Tracking deadlines is not available right now. Say so plainly and do not promise it.");
    const timeZone = await profileTimeZone(engine);
    const due = resolveDueDate(input.due, turnAtMs, timeZone, whatWasSaid(ctx.messages));
    if (!due) throw new Error(`Could not read "${input.due}" as a date. Ask for the date like "November 12".`);
    if (due.status !== "live") return notWritten(due, turnAtMs, timeZone);
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
    const notes = [
      due.yearChanged ? `The year passed was not the one that fits, so this is ${dueDate}. Say the date with its year.` : "",
      firstNudgeAt || out.deadline.status !== "open" ? "" : "This date's reminder times have passed, so no reminder will go out. Say so plainly.",
    ].filter(Boolean);
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
