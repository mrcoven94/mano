import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { answered, requireLiveVoice, syntheticPerson } from "../live.js";

export default defineEval({
  description: "A vague ask for help gets one clarifying question, not a questionnaire.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    const turn = await person.text("I need help with my benefits.");
    t.check(turn, satisfies(answered, "the agent answered"));
    t.check(
      turn.message,
      satisfies((m: string) => (m.match(/\?/g) ?? []).length === 1, "reply asks exactly one question"),
    );
  },
});
