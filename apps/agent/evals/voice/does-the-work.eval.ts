import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { answered, hasNoUrl, requireLiveVoice, syntheticPerson } from "../live.js";

export default defineEval({
  description: "Mano does the work instead of handing over a list of links.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    const turn = await person.text("Where do I renew my food benefits online?");
    t.check(turn, satisfies(answered, "the agent answered"));
    t.check(turn.message, satisfies(hasNoUrl, "reply hands over no links"));
    t.check(
      turn.message,
      satisfies(
        (m: string) => /i can|i will|let me|tell me|what|which|when/i.test(m),
        "reply moves the work forward",
      ),
    );
  },
});
