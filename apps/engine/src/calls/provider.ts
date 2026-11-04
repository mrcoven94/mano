// What Mano needs from a phone company and a speech-to-text model, as two
// small interfaces. No method plays sound on a call: Mano has no speech
// output, so a provider has no way to be asked to speak.
import type { Leg } from "./hold-call.js";

export interface PlaceCall {
  to: string;
  holdCallId: string;
  personId: string;
  leg: Leg;
  // Sent to the provider so a retried command does not dial twice.
  idempotencyKey: string;
  // The provider's own cap on the call, in case a hang up is lost.
  maxSeconds: number;
}

// A verified event about one leg. A provider carries holdCallId, personId
// and leg on the call itself and returns them on every webhook.
export interface CallEvent {
  eventId: string;
  holdCallId: string;
  personId: string;
  leg: Leg;
  providerCallId: string;
  kind: "answered" | "hung_up";
}

export interface CallProvider {
  // True for a stand-in. Receipts carry the flag, so a drill never reads as
  // a real call.
  readonly simulated: boolean;
  // Throws DefiniteFailureError when the provider refused the call and
  // TimeoutError when the outcome is unknown.
  placeCall(call: PlaceCall): Promise<{ providerCallId: string }>;
  sendDtmf(providerCallId: string, digits: string): Promise<void>;
  // Starts sending this leg's audio to Engine in short windows.
  startListening(providerCallId: string): Promise<void>;
  bridge(officeCallId: string, personCallId: string): Promise<void>;
  hangUp(providerCallId: string): Promise<void>;
  // Checks the webhook's signature. "reject" for a bad one, "ignore" for a
  // genuine event Mano does not act on.
  parseWebhook(request: Request): Promise<CallEvent | "ignore" | "reject">;
}

// Must call a Meta model (rule 13). The audio is never stored.
export interface Transcriber {
  transcribe(audio: Uint8Array): Promise<string>;
}

export interface CallConfig {
  // Our own numbers, in E.164. Mano refuses to dial anything else.
  allowedNumbers: ReadonlySet<string>;
  // The one person who may use this, and the one phone that gets rung.
  personId: string;
  personNumber: string;
  holdLimitMs: number;
  ringLimitMs: number;
}

export interface CallServices {
  provider: CallProvider;
  transcriber: Transcriber;
  config: CallConfig;
}

const E164 = /^\+[1-9]\d{7,14}$/;

export function isPhoneNumber(value: unknown): value is string {
  return typeof value === "string" && E164.test(value);
}

function positive(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0.`);
  return n;
}

export interface CallEnv {
  MANO_CALL_ALLOWED_NUMBERS?: string;
  MANO_CALL_PERSON_ID?: string;
  MANO_CALL_PERSON_NUMBER?: string;
  MANO_CALL_HOLD_LIMIT_MINUTES?: string;
  MANO_CALL_RING_LIMIT_SECONDS?: string;
}

// Fails loud on a number that is not E.164: a typo must never widen or
// silently empty the list of numbers Mano may dial.
export function parseCallConfig(env: CallEnv): CallConfig {
  const allowed = (env.MANO_CALL_ALLOWED_NUMBERS ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (allowed.length === 0) throw new Error("MANO_CALL_ALLOWED_NUMBERS needs at least one of our own numbers.");
  for (const number of allowed) {
    if (!isPhoneNumber(number)) throw new Error("MANO_CALL_ALLOWED_NUMBERS must hold E.164 numbers, comma separated.");
  }
  if (!env.MANO_CALL_PERSON_ID) throw new Error("MANO_CALL_PERSON_ID must name the one person who may use calls.");
  if (!isPhoneNumber(env.MANO_CALL_PERSON_NUMBER)) throw new Error("MANO_CALL_PERSON_NUMBER must be an E.164 number.");
  return {
    allowedNumbers: new Set(allowed),
    personId: env.MANO_CALL_PERSON_ID,
    personNumber: env.MANO_CALL_PERSON_NUMBER,
    holdLimitMs: positive("MANO_CALL_HOLD_LIMIT_MINUTES", env.MANO_CALL_HOLD_LIMIT_MINUTES, 60) * 60_000,
    ringLimitMs: positive("MANO_CALL_RING_LIMIT_SECONDS", env.MANO_CALL_RING_LIMIT_SECONDS, 45) * 1000,
  };
}

// Test seam, like setExecutorFactoryForTests. Production code never sets it.
let testServices: CallServices | null = null;

export function setCallServicesForTests(services: CallServices | null): void {
  testServices = services;
}

// No live provider exists yet, so outside tests this is null and a call
// action goes to the gateway's normal executor, which refuses it or
// simulates it as it always has. A live provider and transcriber get built
// here from env, with parseCallConfig.
export function createCallServices(): CallServices | null {
  return testServices;
}
