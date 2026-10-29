// Mano accounts: one person, one account, however they arrive.
// Texting Mano creates the account. Web and app sign in with the same
// phone or with email through WorkOS AuthKit, then use one engine session.
// Run: pnpm --filter @mano/accounts test. Check: pnpm --filter @mano/accounts run check.
// Live needs MANO_ENGINE_URL plus MANO_ENGINE_SERVICE_KEY and the Channels
// code route (MANO_CHANNELS_URL plus MANO_CHANNELS_KEY); production refuses
// to start without them unless MANO_ACCOUNTS_DEMO=1 labels the UI as demo.
// Without MANO_WORKOS_* keys email sign-in answers 503.

export * from "./types";
export * from "./normalize";
export * from "./crypto";
export * from "./locks";
export * from "./config";
export * from "./oauth";
export * from "./store";
export * from "./codes";
export * from "./workos";
export * from "./channels";
export * from "./engine";
export * from "./service";
export * from "./client";
