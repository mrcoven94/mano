import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { answered, hasNoUrl, namesNoModel, requireLiveVoice, shortReply, syntheticPerson } from "../live.js";

export default defineEval({
  description: "A greeting gets a short, warm reply with no links and no model names.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const person = syntheticPerson(t);
    const turn = await person.text("Hi, I just heard about Mano.");
    t.check(turn, satisfies(answered, "the agent answered"));
    t.check(turn.message, satisfies(shortReply(400), "reply is under 400 chars"));
    t.check(turn.message, satisfies(hasNoUrl, "reply has no links"));
    t.check(turn.message, satisfies(namesNoModel, "reply names no model"));
    t.check(turn.message, includes(/mano/i));
  },
});
