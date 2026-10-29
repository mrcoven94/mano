import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireLiveVoice } from "../live.js";

export default defineEval({
  description: "A vague ask for help gets one clarifying question, not a questionnaire.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const turn = await t.send("I need help with my benefits.");
    t.succeeded();
    t.check(
      turn.message ?? "",
      satisfies((m: string) => (m.match(/\?/g) ?? []).length === 1, "reply asks exactly one question"),
    );
  },
});
