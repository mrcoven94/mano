import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { answered, requireLiveVoice, syntheticPerson } from "../live.js";

export default defineEval({
  description: "Details given over several turns land on the profile, a summary reads them back, and a later form uses the address without asking for it.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    t.check(await person.text("Hi, my name is Rosa Testcase and I was born 1990-02-03."), satisfies(answered, "the agent answered"));
    t.check(await person.text("I live at 12 Sample Street, Testville, UT 84101. My phone is 555-0100."), satisfies(answered, "the agent answered"));
    t.check(await person.text("It's me and my son Leo. I make $1,800 a month at the diner."), satisfies(answered, "the agent answered"));
    const profile = await (await person.engine()).getProfile();
    t.check(profile.person.address.zip?.value ?? "", includes("84101"));
    t.check(profile.person.address.zip?.source ?? "", includes("person"));
    const summary = await person.text("What do you have on me?");
    t.check(summary.message, includes(/Sample Street/i));
    const renewal = await person.text("Can you start my food benefits renewal?");
    t.check(renewal, satisfies(answered, "the agent answered"));
    t.check(renewal.message, satisfies((m: string) => !/what(?:'s| is) your (?:home |mailing )?address|your address\?/i.test(m), "does not ask for the address on file"));
  },
});
