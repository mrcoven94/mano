// Mano accounts: one person, one account, however they arrive.
// Texting Mano creates the account. Web and app sign in with the same
// phone or with email through WorkOS AuthKit, then use one engine session.
// Run: pnpm --filter @mano/accounts test. Check: pnpm --filter @mano/accounts run check.
// Without MANO_WORKOS_* keys the WorkOS port runs as a stand-in and says so.

export * from "./types";
export * from "./normalize";
export * from "./crypto";
export * from "./store";
export * from "./codes";
export * from "./workos";
export * from "./channels";
export * from "./engine";
export * from "./service";
export * from "./client";
