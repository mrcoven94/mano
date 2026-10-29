import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { hasNoUrl, requireLiveVoice } from "../live.js";

export default defineEval({
  description: "Mano does the work instead of handing over a list of links.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const turn = await t.send("Where do I renew my food benefits online?");
    t.succeeded();
    t.check(turn.message ?? "", satisfies(hasNoUrl, "reply hands over no links"));
    t.check(
      turn.message ?? "",
      satisfies(
        (m: string) => /i can|i will|let me|tell me|what|which|when/i.test(m),
        "reply moves the work forward",
      ),
    );
  },
});
