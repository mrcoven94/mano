/**
 * Guardian: the checker that reviews every outside action before Mano asks a
 * person to approve it. The action gateway calls check() after its policy
 * check. The answer is pass, fix, or block, with problems in plain words.
 *
 * What it does: RulesChecker needs no keys and blocks content-originated
 * actions, missing consent, and claims with no cited source. GlimmerChecker
 * runs the rules first, then asks the guardian model for a strict-JSON
 * verdict with a 10 second timeout; any failure is a block.
 * GlimmerModelChecker is the model alone, for a caller that runs its own
 * rules first (Engine's action gateway does). Its warm()
 * starts the model ahead of a check, for example when a conversation
 * starts, since a cold start takes minutes. check() takes the person's
 * own names and details to redact by value (Engine reads them from the
 * profile and its suggestions). Each is found however it is written:
 * text and values are folded to letters and digits first, so spacing,
 * case, accents and punctuation never matter, a first name alone still
 * matches, and phones and birth dates match on the number or day they
 * name. A submit carries its form fields with personal values as labels,
 * and a personal field that holds more than its value (an instruction, an
 * extra destination) blocks the check before anything is sent. redact()
 * strips personal details from text going to logs or outside graders.
 *
 * Run it: set MANO_GUARDIAN_RULES_ONLY=1 for explicit local rules-only,
 * or set MANO_GUARDIAN_URL and MANO_GUARDIAN_TOKEN (see .env.example)
 * for the model checker, and use glimmerCheckerFromEnv(). A
 * half-configured endpoint blocks everything instead of silently
 * dropping to rules-only. With no endpoint, run the local stand-in:
 * node standin/server.mjs prints STANDIN_READY with the URL of its
 * single check route; it answers in --mode
 * pass|fix|block|bad-json|error|slow|contradictory|dup-keys.
 *
 * Test it: pnpm --filter @mano/guardian check (tsc plus vitest: unit
 * tests, fail-closed integration tests against the stand-in over real
 * HTTP, a 44-case eval that scores both checkers, and 8 renewal forms
 * scored on the model alone the way Engine runs it).
 *
 * Deploy it: the model endpoint deploys only through
 * .github/workflows/guardian-modal.yml on merge to main, never from a
 * laptop. The workflow needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET as
 * repository secrets, and the mano-guardian Modal secret created by hand.
 */
export type {
  ActionType,
  CheckAction,
  CheckConsent,
  CheckInput,
  CheckResult,
  CheckSource,
  Checker,
  ModelRequest,
  Origin,
  SourceKind,
  Verdict,
  WarmState,
} from "./types.js";
export { RulesChecker } from "./rules.js";
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_GUARDIAN_MODEL,
  GlimmerChecker,
  GlimmerModelChecker,
  MisconfiguredChecker,
  glimmerCheckerFromEnv,
} from "./glimmer.js";
export type { ProxyAuth, ServerInfo } from "./glimmer.js";
export { buildModelRequest, redact } from "./redact.js";
export type { KnownEntities } from "./known.js";
export { canonicalRecipient } from "./rules.js";
