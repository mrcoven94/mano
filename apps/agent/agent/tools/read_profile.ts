import { defineTool } from "eve/tools";
import { z } from "zod";

import { renderProfile, summarizeProfile } from "../lib/profile.js";
import { personEngine } from "../lib/person.js";

export default defineTool({
  description:
    "Read the person's profile as it is right now. Use it when they ask what you have on them (send them the summary in plain words), or to check a fact you saved earlier in this conversation.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const engine = personEngine(ctx);
    if (!engine) throw new Error("The profile is not available right now. Say so plainly.");
    const profile = await engine.getProfile();
    return { summary: summarizeProfile(profile), onFile: renderProfile(profile) ?? "Nothing on file yet." };
  },
});
