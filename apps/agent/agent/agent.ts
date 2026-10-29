// @mano/agent: Mano's brain. One Eve agent answers turns with person
// memory, tools, a yes-or-no approval gate and reminders; Channels
// calls POST /channels/mano/turn and gets the reply text back. Muse
// runs through the Meta Model API directly (standard tier for real
// people, contributor tier when MANO_DATA_CLASS=synthetic). Run:
// pnpm --filter @mano/agent dev (needs META_MODEL_API_KEY, else a
// stand-in answers). Test: pnpm --filter @mano/agent check (tsc plus
// vitest, no keys) and MANO_DATA_CLASS=synthetic pnpm
// --filter @mano/agent eval (live voice evals, needs the key).
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

export default defineAgent({
  model,
  modelContextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
  // No default tools: no shell, no files, no sandbox. Every capability
  // below is an authored Mano tool with its own approval policy.
  defaultTools: false,
  // No delegation: one agent answers the person directly.
  tool: false,
});
