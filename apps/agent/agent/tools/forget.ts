import { defineTool } from "eve/tools";
import { z } from "zod";

import { personMemory, removeFact } from "../lib/memory.js";

export default defineTool({
  description:
    "Forget one remembered fact about the person, exactly as it was saved. Use only when they ask to forget something.",
  inputSchema: z.object({ fact: z.string().min(1).max(500) }),
  async execute({ fact }) {
    const before = personMemory.get().facts.length;
    personMemory.update((memory) => removeFact(memory, fact));
    const after = personMemory.get().facts.length;
    return { removed: after < before, facts: after };
  },
});
