// The deadlines Mano tracks for the person, read from Engine at the start
// of each turn, with the last nudge Mano texted for each: that text is
// not in the conversation history, so a "yes" to it would otherwise
// arrive without its question. Nothing tracked, or Engine unreachable or
// without deadline routes, contributes nothing.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { renderDeadlines } from "../lib/deadlines.js";
import { personEngine } from "../lib/person.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!ctx.session.auth.current?.principalId) return null;
      const engine = personEngine(ctx);
      if (!engine) return null;
      let rendered: string | null;
      try {
        const deadlines = await engine.listDeadlines();
        rendered = deadlines ? renderDeadlines(deadlines, Date.now()) : null;
      } catch (err) {
        console.warn(JSON.stringify({ type: "mano_deadlines_read_failed", err: err instanceof Error ? err.name : "unknown" }));
        return null;
      }
      return rendered ? defineInstructions({ content: rendered }) : null;
    },
  },
});
