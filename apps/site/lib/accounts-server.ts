// Server singleton for withmano.com sign-in and account pages.
// Live by default in production: the real engine accounts routes plus the
// real Channels code route, refused at startup when unwired. Stand-ins run
// only in tests, local dev, and explicit demo mode (MANO_ACCOUNTS_DEMO=1),
// which the sign-in and account pages label. Live WorkOS AuthKit when
// MANO_WORKOS_* keys are set; otherwise email sign-in answers 503.
// Prints which parts are not live once. Never logs secrets or codes.

import {
  AccountsService,
  FetchWorkOS,
  HttpChannels,
  HttpEngineAccounts,
  PersonStore,
  PhoneCodeService,
  RecordingChannels,
  StandInEngineAccounts,
  StandInWorkOS,
  isDemoMode,
  resolveAccountsMode,
  workosConfigured,
  type ChannelsPort,
} from "@mano/accounts";

const DEV_PEPPER = "mano-dev-accounts-pepper-NOT-FOR-PROD";
const DEV_KEK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

function pepper(): string {
  if (process.env.MANO_ACCOUNTS_PEPPER) return process.env.MANO_ACCOUNTS_PEPPER;
  if (!isDev()) throw new Error("Accounts are not configured.");
  return DEV_PEPPER;
}

function kek(): string {
  if (process.env.MANO_ACCOUNTS_KEK_B64) return process.env.MANO_ACCOUNTS_KEK_B64;
  if (!isDev()) throw new Error("Accounts are not configured.");
  return DEV_KEK_B64;
}

// Pepper for OAuth challenge cookies. Refuses in production when unset.
export function accountsPepper(): string {
  return pepper();
}

export function accountsDemo(): boolean {
  return isDemoMode({ MANO_ACCOUNTS_DEMO: process.env.MANO_ACCOUNTS_DEMO });
}

export interface AccountsLive {
  mode: "live" | "demo" | "stand-in";
  workos: "workos" | "stand-in";
  engine: "engine" | "stand-in";
  channels: "channels" | "stand-in";
}

declare global {
  var __manoAccounts: { service: AccountsService; channels: ChannelsPort; live: AccountsLive } | undefined;
}

export function accountsLive(): AccountsLive {
  const mode = resolveAccountsMode({
    NODE_ENV: process.env.NODE_ENV,
    MANO_ENGINE_URL: process.env.MANO_ENGINE_URL,
    MANO_ENGINE_SERVICE_KEY: process.env.MANO_ENGINE_SERVICE_KEY,
    MANO_CHANNELS_URL: process.env.MANO_CHANNELS_URL,
    MANO_CHANNELS_KEY: process.env.MANO_CHANNELS_KEY,
    MANO_ACCOUNTS_DEMO: process.env.MANO_ACCOUNTS_DEMO,
  });
  const liveWorkos = workosConfigured({
    MANO_WORKOS_API_KEY: process.env.MANO_WORKOS_API_KEY,
    MANO_WORKOS_CLIENT_ID: process.env.MANO_WORKOS_CLIENT_ID,
    MANO_WORKOS_REDIRECT_URI: process.env.MANO_WORKOS_REDIRECT_URI,
  });
  const wired = mode.mode === "live";
  return {
    mode: mode.mode,
    workos: liveWorkos ? "workos" : "stand-in",
    engine: wired ? "engine" : "stand-in",
    channels: wired ? "channels" : "stand-in",
  };
}

let loggedStandins = false;

export function accounts(): { service: AccountsService; channels: ChannelsPort; live: AccountsLive } {
  if (!globalThis.__manoAccounts) {
    // Throws in production when the engine or channels are unwired and
    // demo mode is off. Routes map it to 503.
    const live = accountsLive();
    const wired = live.mode === "live";
    const workos = live.workos === "workos"
      ? new FetchWorkOS({
          apiKey: process.env.MANO_WORKOS_API_KEY as string,
          clientId: process.env.MANO_WORKOS_CLIENT_ID as string,
          redirectUri: process.env.MANO_WORKOS_REDIRECT_URI as string,
        })
      : new StandInWorkOS();
    const engine = wired
      ? new HttpEngineAccounts({
          baseUrl: process.env.MANO_ENGINE_URL as string,
          serviceKey: process.env.MANO_ENGINE_SERVICE_KEY as string,
        })
      : new StandInEngineAccounts();
    const channels: ChannelsPort = wired
      ? new HttpChannels(process.env.MANO_CHANNELS_URL as string, process.env.MANO_CHANNELS_KEY as string)
      : new RecordingChannels();
    const service = new AccountsService({
      store: new PersonStore({ pepper: pepper(), kekB64: kek() }),
      codes: new PhoneCodeService({ pepper: pepper() }),
      workos,
      engine,
      channels,
      pepper: pepper(),
    });
    globalThis.__manoAccounts = { service, channels, live };
  }
  const out = globalThis.__manoAccounts;
  if (!loggedStandins) {
    loggedStandins = true;
    const standins = Object.entries(out.live)
      .filter(([k, v]) => k !== "mode" && v === "stand-in")
      .map(([k]) => k);
    if (out.live.mode === "demo") {
      console.info("[mano] accounts in demo mode: stand-ins labeled in the UI.");
    } else if (standins.length > 0) {
      console.info(`[mano] accounts stand-ins: ${standins.join(", ")}. Set MANO_* for live sign-in.`);
    }
  }
  return out;
}

export const SESSION_COOKIE = "mano-session";

export function sessionCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: string } {
  return { httpOnly: true, secure: !isDev(), sameSite: "lax", path: "/" };
}

// OAuth challenge cookie. Short-lived, HttpOnly, Secure outside dev,
// SameSite Lax. The value is a signed challenge, never a secret.
export function oauthCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return { httpOnly: true, secure: !isDev(), sameSite: "lax", path: "/", maxAge: 600 };
}
