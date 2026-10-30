// @mano/persona: Mano's voice in one shared place. The soul, the
// pacing router and its deep-path instructions, the deterministic voice
// guard every outgoing text passes through, the crisis floor, and the
// probe set with its checks. The text line imports it today; the agent
// imports the same words next.
// Run: pnpm --filter @mano/persona check (tsc plus vitest, no keys).
// The live probe run is in packages/channels (probe:live), because it
// drives the real responder.
export * from "./soul.js";
export * from "./pacing.js";
export * from "./guard.js";
export * from "./crisis.js";
export * from "./probes.js";
export * from "./tapbacks.js";
