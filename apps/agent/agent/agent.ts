// @mano/agent: Mano's brain. One Eve agent reads each text, remembers
// the person, proposes actions and keeps reminders. Channels calls POST
// /channels/mano/turn and gets the reply text back. Engine is the system
// of record: memory and proposed actions live there, and only a texted
// YES to Engine's frozen approval sends anything. Muse runs through the
// Meta Model API directly, always on the Standard model ID with
// store:false.
//
// Run: pnpm --filter @mano/agent dev. Without META_MODEL_API_KEY a
// stand-in answers; without ENGINE_URL memory and forms say they are
// unavailable; without KV the agent refuses turns unless MANO_ENV is
// development, which keeps its state in process memory. Test: pnpm
// --filter @mano/agent check (tsc plus vitest, no keys) and pnpm
// --filter @mano/agent eval (live voice evals on synthetic messages).
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { MODEL_CONTEXT_WINDOW_TOKENS, createMuseModel } from "./lib/muse.js";

// Muse through the Meta Model API, called directly. Without a key the
// agent runs a stand-in that says so, so local dev and tests work with
// no accounts; production always sets META_MODEL_API_KEY.
const model = process.env.META_MODEL_API_KEY
  ? createMuseModel().model
  : mockModel({
      modelId: "stand-in",
      provider: "mano",
      respond: "Mano is waking up here: no model key is set, so this is a stand-in reply. Ask again once the key is configured.",
    });

if (!process.env.META_MODEL_API_KEY) {
  console.warn("mano: META_MODEL_API_KEY is not set; the agent answers with a stand-in.");
}
if (!process.env.ENGINE_URL || !process.env.ENGINE_SESSION_SECRET) {
  console.warn("mano: ENGINE_URL or ENGINE_SESSION_SECRET is not set; memory and forms are unavailable.");
}

export default defineAgent({
  model,
  modelContextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
  // No default tools: no shell, no files, no sandbox. Every capability
  // below is an authored Mano tool with its own approval policy.
  defaultTools: false,
  // No delegation: one agent answers the person directly.
  tool: false,
});
