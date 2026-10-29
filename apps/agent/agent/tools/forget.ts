import { defineTool } from "eve/tools";
import { z } from "zod";

import { engineFromEnv, personIdFor } from "../lib/engine.js";
import { forgetFact } from "../lib/memory.js";
import { requireHandleHash } from "../lib/person.js";

export default defineTool({
  description:
    "Forget one remembered fact about the person, exactly as it was saved. Use only when they ask to forget something. If deletion is unavailable, tell them plainly it is still saved.",
  inputSchema: z.object({ fact: z.string().min(1).max(500) }),
  async execute({ fact }, ctx) {
    const engine = engineFromEnv();
    if (!engine) throw new Error("Memory is not available right now. Say so plainly.");
    return forgetFact(engine, personIdFor(requireHandleHash(ctx)), fact);
  },
});
