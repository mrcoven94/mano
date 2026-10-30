// Puts the person's profile in front of the model at the start of each
// turn, so it reads what is on file before it asks. System role: always
// current, never pinned in history. An empty or unreachable profile adds
// nothing.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { renderProfile } from "../lib/profile.js";
import { personEngine } from "../lib/person.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!ctx.session.auth.current?.principalId) return null;
      const engine = personEngine(ctx);
      if (!engine) return null;
      try {
        const rendered = renderProfile(await engine.getProfile());
        return rendered ? defineInstructions({ content: rendered }) : null;
      } catch (err) {
        console.warn(JSON.stringify({ type: "mano_profile_read_failed", err: err instanceof Error ? err.name : "unknown" }));
        return null;
      }
    },
  },
});
