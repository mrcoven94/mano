# @mano/guardian

The checker that reviews every outside action before Mano asks a person to approve it. The action gateway calls `check()` after its policy check. The checker answers `pass`, `fix`, or `block`, with problems written in plain words.

Two checkers implement the same interface:

- `RulesChecker` needs no keys and no network. It blocks when the action came from something Mano read rather than from the person, when no consent covers the recipient and purpose, and when a statement in the payload has no cited source. This is the default for anyone running Mano without a GPU.
- `GlimmerChecker` runs the rules first, then asks the guardian model for a verdict as strict JSON, with a 10 second timeout. Any failure (timeout, network error, error status, unparsable answer) is a block. It never calls the model when the rules already block.

`redact()` strips names, ID and case numbers, addresses, employers, birth dates, phone numbers, and emails from text going to logs or outside graders. Names and employers have no shape, so callers pass the ones they know.

## Run with rules only

```sh
pnpm --filter @mano/guardian check
```

No endpoint configured means rules only. `glimmerCheckerFromEnv()` returns null when `MANO_GUARDIAN_URL` or `MANO_GUARDIAN_TOKEN` is missing; the gateway treats that as rules only and says so in its status.

## Local stand-in

`standin/server.mjs` speaks just enough of the chat completions API to run `GlimmerChecker` end to end with no GPU:

```sh
node standin/server.mjs --mode pass &          # prints STANDIN_READY <url>
MANO_GUARDIAN_URL=<url> MANO_GUARDIAN_TOKEN=stand-in-token pnpm test
```

Modes are `pass`, `fix`, `block`, `bad-json`, `error`, and `slow`. The integration tests in `test/standin.test.ts` start it on random ports and cover the fail-closed paths over real HTTP.

## Deploy your own guardian model

The model is Muse Glimmer (open weights, Apache 2.0), FP8 quantized, served with vLLM on one L40S on Modal. It scales to zero when idle and caches weights in a Modal volume.

Production deploys run only through `.github/workflows/guardian-modal.yml`: merging to main with changes under `packages/guardian/modal/` caches the weights (CPU step, no GPU billed) and redeploys. Never run `modal deploy` from a laptop for production. The workflow needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` as repository secrets, and the `mano-guardian` Modal secret (holding the bearer token) created once by hand.

Then set `MANO_GUARDIAN_URL` to the deployed URL and `MANO_GUARDIAN_TOKEN` to the same token. `MANO_GUARDIAN_MODEL` defaults to the deployed checkpoint (`RedHatAI/Muse-Glimmer-30B-FP8-block`).

Notes:

- The endpoint speaks the OpenAI chat completions API and requires `Authorization: Bearer` on every request.
- Request logging is off on the server, and problem messages never name models or providers.
- The first check after idle fails closed: cold start takes minutes (see below), far past the 10 second check timeout, so the gateway should treat that block as "starting, retry" and ask again once warm.
- Cost guardrails: at most one GPU container, 60 second scaledown, weights cached in a volume. Measured numbers are in the pull request.

## Eval

`eval/` holds 40 synthetic actions, half good and half bad (planted instructions, wrong recipients, unsupported statements, missing consents). The eval runs with `pnpm check`: the rules half always runs, and the model half runs when the endpoint is configured.

Rules results are fixed by construction: precision 0.882 (15 of 17 flags are real), recall 0.750 (15 of 20 bad actions caught), accuracy 0.825. The five misses are planted instructions hidden inside well-formed, consented actions, which only the model sees; the two false flags are true statements worded differently from their quotes, which the strict containment rule fails closed on. Model results depend on the deployment and are printed per run.

## Interface

```ts
interface CheckInput {
  action: {
    type: "send" | "submit" | "call" | "fax" | "share";
    recipient: string;
    purpose: string;
    payload: unknown;
    documentHash: string | null;
  };
  sources: { kind: "document" | "message" | "profile" | "program"; id: string; quote?: string }[];
  consents: { recipient: string; purpose: string }[];
  origin: "person" | "content";
}
interface CheckResult {
  verdict: "pass" | "fix" | "block";
  problems: string[];
}
interface Checker {
  check(input: CheckInput): Promise<CheckResult>;
}
```

Claims are read from a string payload, a string array, or an object with `claims: string[]` or `text: string`. Anything else carries no claims and skips the source check.
