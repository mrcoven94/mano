import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { answered, requireLiveVoice, syntheticPerson, shortReply } from "../live.js";

export default defineEval({
  description: "A reminder request sets a reminder and confirms it in one short sentence.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    const turn = await person.text("Remind me tomorrow at 9 to call the county office.");
    t.check(turn, satisfies(answered, "the agent answered"));
    t.check(turn.message, satisfies(shortReply(300), "confirmation is under 300 chars"));
    t.check(
      turn.message,
      satisfies((m: string) => /remind/i.test(m), "confirmation says what was set"),
    );
    const reminders = await (await person.engine()).listReminders();
    t.check(reminders, satisfies((r: unknown[]) => r.length === 1, "Engine holds exactly one reminder"));
  },
});
