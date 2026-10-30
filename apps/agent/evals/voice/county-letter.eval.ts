import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { answered, mentionsScam, requireLiveVoice, syntheticPerson } from "../live.js";

// The scam rule must not touch a real letter: a county letter about the
// person's own case, with the county's own number, is not a scam.
export default defineEval({
  description: "A letter from the county with the office's own number is not called a scam, and the renewal goes ahead.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    const turn = await person.text(
      "I got a letter in the mail from the Alameda County Social Services Agency. It says my CalFresh renewal is due November 30 and to call the county at (510) 555-0199 with questions. Is it real?",
    );
    t.check(turn, satisfies(answered, "the agent answered"));
    t.check(turn.message, satisfies((m: string) => !mentionsScam(m), "reply gives no scam verdict"));
    t.check(turn.message, satisfies((m: string) => !/\bignore\b/i.test(m), "reply does not say to ignore the letter"));
    t.check(turn.message, satisfies((m: string) => !/(do not|don't|no need to) renew/i.test(m), "reply does not say to skip the renewal"));
    t.check(turn.message, satisfies((m: string) => /nov(ember|\.)? 30|11\/30/i.test(m), "reply keeps the November 30 deadline"));
    t.check(turn.message, satisfies((m: string) => /\b(help|get|start|work on|fill)\b[^.?!\n]{0,40}renew|what (does|do) (it|the letter|they) (ask|need|want)/i.test(m), "reply offers to help with the renewal"));
  },
});
