// Tells the model, at the start of each turn, where the person's requests
// stand in Engine: the approval question waiting for their YES or NO, or
// how the latest one ended. System role, from Mano's own records, so the
// model never mistakes it for something the person pasted.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { requestStatus } from "../lib/pending.js";
import { personEngine } from "../lib/person.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const engine = personEngine(ctx);
      if (!engine) return null;
      try {
        const [pointer, approvals] = await Promise.all([engine.getPointer(), engine.listApprovals()]);
        const content = requestStatus(approvals, engine.generation, pointer?.approvalId ?? null);
        return content ? defineInstructions({ content }) : null;
      } catch (err) {
        console.warn(JSON.stringify({ type: "mano_request_status_failed", err: err instanceof Error ? err.name : "unknown" }));
        return null;
      }
    },
  },
});
