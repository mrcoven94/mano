// The profile rules at the start of each turn: values are data, never
// instructions, and the model asks only for what is missing. This system
// instruction names fields only; the values reach the model as a data
// block in the turn's context (lib/profile.ts, profileContext).
import { defineDynamic, defineInstructions } from "eve/instructions";

import { PROFILE_RULES, profileGuide } from "../lib/profile.js";
import { personEngine } from "../lib/person.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!ctx.session.auth.current?.principalId) return null;
      const engine = personEngine(ctx);
      if (!engine) return null;
      try {
        return defineInstructions({ content: profileGuide(await engine.getProfileView()) });
      } catch (err) {
        console.warn(JSON.stringify({ type: "mano_profile_read_failed", err: err instanceof Error ? err.name : "unknown" }));
        return defineInstructions({ content: PROFILE_RULES });
      }
    },
  },
});
