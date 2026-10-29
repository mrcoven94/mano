// Accounts runtime mode. Production refuses to start on stand-ins: the
// site needs the real engine URL plus credentials and the real Channels
// code route, or an explicit demo mode the UI labels. Tests and local dev
// use stand-ins. Env names only, never values.
//
// MANO_ENGINE_URL: engine Worker base URL (accounts routes contract in engine.ts).
// MANO_ENGINE_SERVICE_KEY: server-to-server credential for those routes.
// MANO_CHANNELS_URL: Channels Worker base URL for the code route.
// MANO_CHANNELS_KEY: credential for the Channels code route.
// MANO_ACCOUNTS_DEMO=1: explicit demo mode, labeled in the UI.

export interface AccountsEnv {
  NODE_ENV?: string;
  MANO_ENGINE_URL?: string;
  MANO_ENGINE_SERVICE_KEY?: string;
  MANO_CHANNELS_URL?: string;
  MANO_CHANNELS_KEY?: string;
  MANO_ACCOUNTS_DEMO?: string;
}

export type AccountsMode =
  | { mode: "live"; engineUrl: string }
  | { mode: "demo" }
  | { mode: "stand-in" };

export class AccountsNotConfiguredError extends Error {
  constructor() {
    super("Accounts are not configured.");
    this.name = "AccountsNotConfiguredError";
  }
}

export function isDemoMode(env: AccountsEnv): boolean {
  return env.MANO_ACCOUNTS_DEMO === "1";
}

// Throws AccountsNotConfiguredError when production would run on stand-ins.
export function resolveAccountsMode(env: AccountsEnv): AccountsMode {
  const engineReady = Boolean(env.MANO_ENGINE_URL && env.MANO_ENGINE_SERVICE_KEY);
  const channelsReady = Boolean(env.MANO_CHANNELS_URL && env.MANO_CHANNELS_KEY);
  if (engineReady && channelsReady) {
    return { mode: "live", engineUrl: (env.MANO_ENGINE_URL as string).replace(/\/$/, "") };
  }
  if (isDemoMode(env)) return { mode: "demo" };
  if (env.NODE_ENV !== "production") return { mode: "stand-in" };
  throw new AccountsNotConfiguredError();
}
