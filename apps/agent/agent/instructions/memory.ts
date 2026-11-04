// Reads the person's remembered facts from Engine at the start of each
// turn so the model never asks twice. System role: always current, never
// pinned in history. Empty or unreachable memory contributes nothing.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { recallFacts, renderMemory } from "../lib/memory.js";
import { personEngine } from "../lib/person.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!ctx.session.auth.current?.principalId) return null;
      const engine = personEngine(ctx);
      if (!engine) return null;
      let facts: string[];
      try {
        facts = await recallFacts(engine);
      } catch (err) {
        console.warn(JSON.stringify({ type: "mano_memory_recall_failed", err: err instanceof Error ? err.name : "unknown" }));
        return null;
      }
      const rendered = renderMemory(facts);
      return rendered ? defineInstructions({ content: rendered }) : null;
    },
  },
});
