import { defineTool } from "eve/tools";
import { z } from "zod";

import { forgetFact } from "../lib/memory.js";
import { personEngine } from "../lib/person.js";

export default defineTool({
  description:
    "Forget one remembered fact about the person, exactly as it was saved. Use only when they ask to forget something.",
  inputSchema: z.object({ fact: z.string().min(1).max(500) }),
  async execute({ fact }, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("Memory is not available right now. Say so plainly.");
    return forgetFact(engine, fact);
  },
});
