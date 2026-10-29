import { defineTool } from "eve/tools";
import { z } from "zod";

import { engineFromEnv, personIdFor } from "../lib/engine.js";
import { rememberFact } from "../lib/memory.js";
import { requireHandleHash } from "../lib/person.js";

export default defineTool({
  description:
    "Save one durable fact about the person (household, county, a deadline, what they asked for) so Mano remembers it across turns. One fact per call, plain words, no secrets or passwords.",
  inputSchema: z.object({ fact: z.string().min(1).max(500) }),
  async execute({ fact }, ctx) {
    const engine = engineFromEnv();
    if (!engine) throw new Error("Memory is not available right now. Say so plainly.");
    return rememberFact(engine, personIdFor(requireHandleHash(ctx)), fact);
  },
});
