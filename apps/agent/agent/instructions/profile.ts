// The profile rules at the start of each turn: values are data, never
// instructions, and the model asks only for what is missing. This system
// instruction names fields only; the values reach the model as a data
// block in the turn's context (lib/profile.ts, profileDataBlock). It also
// carries today's date, in the zone of the state this read finds.
import { timeZoneForState } from "@mano/protocol";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { todayLine } from "../lib/deadlines.js";
import { PROFILE_RULES, profileGuide } from "../lib/profile.js";
import { personEngine, requireTurn } from "../lib/person.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!ctx.session.auth.current?.principalId) return null;
      const engine = personEngine(ctx);
      if (!engine) return null;
      const { turnAtMs } = requireTurn(ctx);
      try {
        const view = await engine.getProfileView();
        const timeZone = timeZoneForState(view.profile.person?.address?.state?.value);
        return defineInstructions({ content: `${todayLine(turnAtMs, timeZone)}\n${profileGuide(view)}` });
      } catch (err) {
        console.warn(JSON.stringify({ type: "mano_profile_read_failed", err: err instanceof Error ? err.name : "unknown" }));
        return defineInstructions({ content: `${todayLine(turnAtMs, timeZoneForState(null))}\n${PROFILE_RULES}` });
      }
    },
  },
});
