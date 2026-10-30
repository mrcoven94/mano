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
    const memory = await (await person.engine()).listMemory();
    t.check(memory, satisfies((rows: { content: string }[]) => rows.some((r) => /salt lake/i.test(r.content)), "Engine remembers the county"));
    const second = await person.text("What county do I live in?");
    t.check(second, satisfies(answered, "the agent answered"));
    t.check(second.message, includes(/salt lake/i));
  },
});
