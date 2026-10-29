import { defineTool } from "eve/tools";
import { z } from "zod";

import { addFact, personMemory } from "../lib/memory.js";

export default defineTool({
  description:
    "Save one durable fact about the person (household, county, a deadline, what they asked for) so Mano remembers it across turns. One fact per call, plain words, no secrets or passwords.",
  inputSchema: z.object({ fact: z.string().min(1).max(500) }),
  async execute({ fact }) {
    personMemory.update((memory) => addFact(memory, fact));
    return { saved: true, facts: personMemory.get().facts.length };
  },
});
