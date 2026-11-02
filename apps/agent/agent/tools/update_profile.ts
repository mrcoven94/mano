import { defineTool } from "eve/tools";
import { z } from "zod";

import { ProfileRefused } from "../lib/engine.js";
import { FORGET_NAMES, ProfileInputProblem, profileChanges, profileKey } from "../lib/profile.js";
import { personEngine, requireTurn } from "../lib/person.js";

const text = (max = 200) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");

export default defineTool({
  description:
    "Save facts the person just told you to their profile: name, date of birth, phone, email, address, county, language, household members, income and programs with case numbers. " +
    "Save only what they said themselves, in their words. Never save a guess, an estimate, or something you inferred. " +
    "To change a household member, income or program already on file, pass its ref from the profile. A household member changes only by ref: a name already on file with a different relationship or birth date is added as a different person; otherwise pass the ref, or new: true for someone else with the same name, and ask the person if you are not sure. " +
    "Set householdComplete when the person says who lives with them is everyone (for example \"just me and my son\"). " +
    "A fact the person already gave stays even if a document or older note says otherwise: that value waits for their confirmation, and saving their answer here settles it. " +
    `Use forget when they ask you to forget something (${FORGET_NAMES.join(", ")}, or an entry's ref). ` +
    "Afterward confirm what changed in one short line. Facts that do not fit the profile go to remember instead.",
  inputSchema: z.object({
    person: z
      .object({
        fullName: text(),
        dateOfBirth: date,
        phone: text(40),
        email: text(200),
        address: z
          .object({ line1: text(), line2: text(), city: text(), state: z.string().regex(/^[A-Za-z]{2}$/), zip: z.string().regex(/^\d{5}(-\d{4})?$/) })
          .partial(),
        county: text(),
        language: text(60),
      })
      .partial()
      .optional(),
    household: z
      .array(
        z
          .object({ ref: z.string(), new: z.boolean().describe("A different person with a name already on file"), name: text(), relationship: text(60), dateOfBirth: date })
          .partial(),
      )
      .max(15)
      .optional(),
    householdComplete: z.boolean().optional().describe("The person said the household on file is everyone who lives with them"),
    income: z
      .array(
        z
          .object({
            ref: z.string().optional(),
            member: text(100).describe('"self", or the household member\'s name'),
            source: text().describe("Where it comes from, such as a job or child support"),
            amount: z.number().min(0),
            frequency: z.enum(["weekly", "biweekly", "monthly", "yearly"]),
          })
          .partial(),
      )
      .max(15)
      .optional(),
    programs: z
      .array(z.object({ ref: z.string().optional(), program: text(60), state: z.string().regex(/^[A-Za-z]{2}$/), caseNumber: text(40), status: text(60) }).partial())
      .max(15)
      .optional(),
    forget: z.array(z.string().min(1).max(64)).max(10).optional(),
  }),
  async execute(input, ctx) {
    const { turnId } = requireTurn(ctx);
    const engine = personEngine(ctx);
    if (!engine) throw new Error("The profile is not available right now. Say so plainly and do not claim anything was saved.");
    let changes;
    try {
      const view = await engine.getProfileView();
      changes = profileChanges(input, view.profile, turnId, new Set(view.suggestions.map((s) => s.path)));
    } catch (err) {
      if (err instanceof ProfileInputProblem) return { saved: [], problem: err.message };
      throw err;
    }
    const paths = Object.keys(changes.fields);
    if (paths.length === 0) return { saved: [], note: "Nothing to save." };
    try {
      const out = await engine.patchProfile({ idempotencyKey: profileKey(turnId, changes.fields), source: "person", fields: changes.fields });
      const label = (p: string) => changes.labels[p] ?? p;
      return {
        saved: [...new Set(out.changed.map(label))],
        waitingForConfirmation: [...new Set(out.suggested.map(label))],
        forgotten: [...new Set(out.cleared.map(label))],
        alreadyOnFile: [...new Set(out.unchanged.map(label))],
      };
    } catch (err) {
      if (err instanceof ProfileRefused) return { saved: [], problem: err.reason };
      throw err;
    }
  },
});
