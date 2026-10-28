// @mano/channels: the messaging library behind the channels worker. One
// Channel interface per provider (Blooio today; SMS and email later), a
// recording stand-in for tests and local runs, the Responder interface
// (plain Muse Spark today, the engine's person agent later), and the
// pure pieces the worker builds on: handles, signatures, bubbles, limits,
// approvals and per-person encryption. Run: pnpm --filter @mano/channels
// check (tsc plus vitest, no keys needed).
export * from "./types.js";
export * from "./channel.js";
export * from "./handles.js";
export * from "./verify.js";
export * from "./blooio.js";
export * from "./recording.js";
export * from "./responder.js";
export * from "./bubbles.js";
export * from "./approvals.js";
export * from "./limits.js";
export * from "./crypto.js";
export * from "./log.js";
export * from "./links.js";
