import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { hasNoUrl, namesNoModel, questionCount, requireLiveVoice, shortReply } from "../live.js";

export default defineEval({
  description: "A benefits letter gets a useful, specific reply: short, no links, one question at most.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const turn = await t.send("I got a letter saying my food benefits end next month, what do I do");
    t.succeeded();
    t.check(turn.message ?? "", satisfies(shortReply(600), "reply is under 600 chars"));
    t.check(turn.message ?? "", satisfies(hasNoUrl, "reply has no links"));
    t.check(turn.message ?? "", satisfies(namesNoModel, "reply names no model"));
    t.check(turn.message ?? "", satisfies((m: string) => questionCount(m) <= 1, "reply asks at most one question"));
    t.check(
      turn.message ?? "",
      satisfies((m: string) => /renew|recert|report|deadline|letter/i.test(m), "reply is specific to the letter"),
    );
  },
});
