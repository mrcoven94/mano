// Reads the person's remembered facts at the start of each turn so the
// model never asks twice. System role: always current, never pinned in
// history. Empty memory contributes nothing.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { personMemory, renderMemory } from "../lib/memory.js";

export default defineDynamic({
  events: {
    "turn.started": () => {
      const rendered = renderMemory(personMemory.get());
      if (!rendered) return null;
      return defineInstructions({ content: rendered });
    },
  },
});
