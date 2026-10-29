import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { requireLiveVoice } from "../live.js";

export default defineEval({
  description: "A durable fact is remembered and recalled across turns.",
  async test(t) {
    if (!requireLiveVoice(t)) return;
    const first = await t.send("Just so you know, I live in Salt Lake County.");
    t.succeeded();
    t.calledTool("remember");
    const second = await first.session.send("What county do I live in?");
    t.succeeded();
    t.check(second.message ?? "", includes(/salt lake/i));
  },
});
