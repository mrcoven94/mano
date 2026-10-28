// Server singleton for withmano.com sign-in and account pages.
// Uses @mano/accounts against a stand-in engine until the engine accounts
// routes land (after PR #2). Live WorkOS AuthKit when MANO_WORKOS_* keys
// are set; otherwise a stand-in. Prints which parts are not live once.
// Phone codes go through the recording stand-in here; live sends ride the
// Channels service binding from the engine, after PR #41.

import {
  AccountsService,
  FetchWorkOS,
  PersonStore,
  PhoneCodeService,
  RecordingChannels,
  StandInEngineAccounts,
  StandInWorkOS,
  workosConfigured,
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

export interface AccountsLive {
  workos: "workos" | "stand-in";
  engine: "stand-in";
  channels: "stand-in";
}

declare global {
  var __manoAccounts: { service: AccountsService; channels: RecordingChannels; live: AccountsLive } | undefined;
}

export function accountsLive(): AccountsLive {
  const liveWorkos = workosConfigured({
    MANO_WORKOS_API_KEY: process.env.MANO_WORKOS_API_KEY,
    MANO_WORKOS_CLIENT_ID: process.env.MANO_WORKOS_CLIENT_ID,
    MANO_WORKOS_REDIRECT_URI: process.env.MANO_WORKOS_REDIRECT_URI,
  });
  return { workos: liveWorkos ? "workos" : "stand-in", engine: "stand-in", channels: "stand-in" };
}

let loggedStandins = false;

export function accounts(): { service: AccountsService; channels: RecordingChannels; live: AccountsLive } {
  if (!globalThis.__manoAccounts) {
    const live = accountsLive();
    const workos = live.workos === "workos"
      ? new FetchWorkOS({
          apiKey: process.env.MANO_WORKOS_API_KEY as string,
          clientId: process.env.MANO_WORKOS_CLIENT_ID as string,
          redirectUri: process.env.MANO_WORKOS_REDIRECT_URI as string,
        })
      : new StandInWorkOS();
    const channels = new RecordingChannels();
    const service = new AccountsService({
      store: new PersonStore({ pepper: pepper(), kekB64: kek() }),
      codes: new PhoneCodeService({ pepper: pepper() }),
      workos,
      engine: new StandInEngineAccounts(),
      channels,
      pepper: pepper(),
    });
    globalThis.__manoAccounts = { service, channels, live };
  }
  const out = globalThis.__manoAccounts;
  if (!loggedStandins) {
    loggedStandins = true;
    const standins = Object.entries(out.live)
      .filter(([, v]) => v === "stand-in")
      .map(([k]) => k);
    if (standins.length > 0) {
      console.info(`[mano] accounts stand-ins: ${standins.join(", ")}. Set MANO_WORKOS_* for live email sign-in.`);
    }
  }
  return out;
}

export const SESSION_COOKIE = "mano-session";

export function sessionCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: string } {
  return { httpOnly: true, secure: !isDev(), sameSite: "lax", path: "/" };
}
