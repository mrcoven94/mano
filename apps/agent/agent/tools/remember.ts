import { defineTool } from "eve/tools";
import { z } from "zod";

import { rememberFact } from "../lib/memory.js";
import { personEngine } from "../lib/person.js";

export default defineTool({
  description:
    "Save one durable fact about the person that does not fit the profile (a deadline, what they asked for, how they like to be reached) so Mano remembers it across turns. Name, address, county, household, income and programs go to update_profile instead. One fact per call, plain words, no secrets or passwords.",
  inputSchema: z.object({ fact: z.string().min(1).max(500) }),
  async execute({ fact }, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Memory is not available right now. Say so plainly.");
    return rememberFact(engine, fact);
  },
});
