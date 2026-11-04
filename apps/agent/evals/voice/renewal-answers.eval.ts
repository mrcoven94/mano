import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { answered, requireLiveVoice, syntheticPerson } from "../live.js";

// What a synthetic person texts when asked, by what the question is about.
const ANSWERS: [RegExp, string][] = [
  [/case number/i, "VE-SNAP-263507"],
  [/legal name/i, "Nivra Pellorin"],
  [/date of birth/i, "03/14/1985"],
  [/how many people/i, "3"],
  [/how much does your household earn/i, "1800"],
  [/mailing address/i, "703 Frendle Path, Drelvessa, Kelvessa 00042"],
  [/phone number/i, "(202) 555-0142"],
];

export default defineEval({
  description: "A renewal answered over several texts asks each question once and leaves every answer on the profile.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    let reply = await person.text("Can you fill out my food benefits renewal for me?");
    const asked = new Set<RegExp>();
    for (let i = 0; i < ANSWERS.length; i++) {
      t.check(reply, satisfies(answered, "the agent answered"));
      const next = ANSWERS.find(([question]) => question.test(reply.message));
      if (!next) break;
      t.check(reply.message, satisfies(() => !asked.has(next[0]), "asks each question once"));
      asked.add(next[0]);
      reply = await person.text(next[1]);
    }
    const { profile } = await (await person.engine()).getProfileView();
    t.check(profile.person.fullName?.value ?? "", includes("Nivra Pellorin"));
    t.check(profile.person.dateOfBirth?.value ?? "", includes("1985-03-14"));
    t.check(String(profile.person.householdSize?.value ?? ""), includes("3"));
    t.check(profile.person.phone?.value ?? "", includes("555-0142"));
    t.check(profile.programs.map((p) => p.caseNumber?.value).join(), includes("VE-SNAP-263507"));
  },
});
