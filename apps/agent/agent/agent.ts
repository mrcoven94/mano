// @mano/agent: Mano's brain. One Eve agent reads each text, remembers
// the person, proposes actions and keeps reminders. Channels calls POST
// /channels/mano/turn and gets the reply text back. Engine is the system
// of record: the person's profile, memory and proposed actions live
// there, and only a texted YES to Engine's frozen approval sends anything.
// MANO_MODEL_PROVIDER picks the model route (lib/muse.ts). Production sets
// it to modal: Meta's open-weight model on a Modal Shared Endpoint. With no
// route set, turns go to the Meta Model API on the Standard model ID with
// store:false.
//
// A texted photo is read inside the turn (lib/letters.ts, @mano/mail):
// Channels stores it in Engine, the agent reads it back, answers what the
// letter is, its deadline and what to send, and holds a published
// deadline in Engine.
//
// fill_form fills a fresh draft of a form on the person's computer
// (packages/computer) from their Engine profile, reads the draft back
// from the sandbox portal, and holds exactly what the portal saved for
// their YES. It needs MANO_PORTAL_URL, SANDBOX_PORTAL_DRAFT_TOKEN and
// MODAL_COMPUTER_URL (see .env.example) plus Engine's GET /profile, and
// says it is unavailable without them; the model then prepares the
// renewal with start_form_draft from the person's answers.
//
// share_case and stop_sharing hold a share with the one test office for the
// person's YES (lib/sharing.ts), and a photo sent while that office waits on
// a document is asked about the same way.
//
// Engine also holds the agent's own state for each person (reminders
// and tracked deadlines, whose texts its alarm delivers through Channels,
// the turn ledger and the approval pointer), so the agent keeps no store
// of its own.
//
// Run: pnpm --filter @mano/agent dev, with Engine running (locally,
// pnpm --filter @mano/engine dev). Without a key for the chosen model
// route (META_MODEL_API_KEY, or OPENROUTER_API_KEY when
// MANO_MODEL_PROVIDER=openrouter, or MODAL_PROXY_TOKEN and MODAL_ENDPOINT_URL
// when MANO_MODEL_PROVIDER=modal) a stand-in answers; without ENGINE_URL
// and MANO_ENGINE_AGENT_TOKEN the turn route answers 503. Test: pnpm
// --filter @mano/agent check (tsc plus vitest, no keys, against Engine's
// own auth, gateway and agent-state code) and pnpm --filter @mano/agent
// eval (live voice evals on synthetic messages).
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { MODEL_CONTEXT_WINDOW_TOKENS, createMuseModel, selectModelRoute } from "./lib/muse.js";

// Muse through the route muse.ts picks. Without a key for that route the
// agent runs a stand-in that says so, so local dev and tests work with
// no accounts; production always sets the key.
const route = selectModelRoute();
const model = route.apiKey
  ? createMuseModel().model
  : mockModel({
      modelId: "stand-in",
      provider: "mano",
      respond: "Mano is waking up here: no model key is set, so this is a stand-in reply. Ask again once the key is configured.",
    });

if (route.apiKey) {
  console.log(`mano: model path ${route.name} ${route.modelId}`);
} else {
  console.warn(
    "mano: model path stand-in; set META_MODEL_API_KEY, or MANO_MODEL_PROVIDER=openrouter with OPENROUTER_API_KEY, or MANO_MODEL_PROVIDER=modal with MODAL_PROXY_TOKEN and MODAL_ENDPOINT_URL (an https URL on Modal's endpoint domain).",
  );
}
if (!process.env.ENGINE_URL || !process.env.MANO_ENGINE_AGENT_TOKEN) {
  console.warn("mano: ENGINE_URL or MANO_ENGINE_AGENT_TOKEN is not set; turns are refused until Engine is configured.");
}

export default defineAgent({
  model,
  modelContextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
  // No default tools: no shell, no files, no sandbox. Every capability
  // below is an authored Mano tool with its own approval policy.
  defaultTools: false,
  // No delegation: one agent answers the person directly.
  tool: false,
  // sharp loads a native binary by a path it builds at run time, so a
  // bundled copy cannot find it and every photo would go unread.
  build: { externalDependencies: ["sharp"] },
});
