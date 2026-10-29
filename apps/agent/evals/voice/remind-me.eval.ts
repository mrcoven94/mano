import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireLiveVoice, shortReply } from "../live.js";

export default defineEval({
  description: "A reminder request sets a reminder and confirms it in one short sentence.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const turn = await t.send("Remind me tomorrow at 9 to call the county office.");
    t.succeeded();
    t.calledTool("remind");
    t.check(turn.message ?? "", satisfies(shortReply(300), "confirmation is under 300 chars"));
    t.check(
      turn.message ?? "",
      satisfies((m: string) => /remind/i.test(m), "confirmation says what was set"),
    );
  },
});
