import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { answered, requireLiveVoice, syntheticPerson } from "../live.js";

export default defineEval({
  description: "A durable fact is remembered and recalled across turns.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    const first = await person.text("Just so you know, I live in Salt Lake County.");
    t.check(first, satisfies(answered, "the agent answered"));
    const profile = await (await person.engine()).getProfile();
    t.check(profile.person.county?.value ?? "", satisfies((county: string) => /salt lake/i.test(county), "Engine has the county on the profile"));
    const second = await person.text("What county do I live in?");
    t.check(second, satisfies(answered, "the agent answered"));
    t.check(second.message, includes(/salt lake/i));
  },
});
