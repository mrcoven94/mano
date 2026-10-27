# Mano engine

Cloudflare Worker with one Agents SDK agent per person and per organization. Every outside action goes through the action gateway: decide, log, then act, and fail closed.

## Run locally

```bash
pnpm --filter @mano/engine dev
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets. Without keys the engine runs on stand-ins (simulated executor, stand-in model) and says so on `/health`.

## Check and test

```bash
pnpm --filter @mano/engine run check   # typecheck plus both test suites
pnpm --filter @mano/engine run smoke   # one live synthetic model call (needs META_MODEL_API_KEY)
```

## Auth

Person routes take a Bearer session token whose subject matches the route. Org routes take a staff token carrying the matching org ID. Minting and verification live in `src/auth.ts`; `SESSION_SECRET` signs the tokens.

## HTTP surface

- `GET /health` returns `{ ok, live }`: which parts are live and which are stand-ins (labels only, no values).
- `POST /api/persons/:id/chat` with `{ message }`.
- `POST /api/persons/:id/action` with an action request (the worker stamps `personId` from the token).
- `GET /api/persons/:id/approvals` lists pending approvals.
- `POST /api/persons/:id/approvals/:aid/approve` executes the stored request.
- `POST /api/persons/:id/documents` with `{ name, contentB64 }` stores an encrypted document.
- `GET /api/persons/:id/ws` upgrades to chat (Bearer header, or `?token=` for browsers).
- `GET /api/orgs/:id/cases` lists shared cases for staff.
- `POST /api/check-link` with `{ url }` runs the family-safe link check.

## Gateway and checker

`src/gateway` holds the action gateway: request validation, policy, link checks, the Checker hook, hash-bound approvals, single-flight attempts and timeout reconcile. The checker shape (`CheckInput`, `CheckResult`, `Checker`) is the Guardian session's contract; `LocalRulesChecker` is the default until it lands.

## Executors

`EXECUTOR_MODE=simulated` (default) records calls and labels every receipt simulated. `EXECUTOR_MODE=sandbox` with `SANDBOX_BASE_URL` files into the sandbox agency portal: `POST {base}/v1/actions` with the action JSON returns `{ externalId }` (deduped on `idempotencyKey`), and `GET {base}/v1/actions/by-key/{key}` returns `{ externalId }` or 404.

## Secrets

Never put a key on a command line. Set secrets from stdin:

```bash
~/Desktop/code/bin/ws keys run -- sh -c 'printf %s "$META_MODEL_API_KEY" | pnpm --filter @mano/engine exec wrangler secret put META_MODEL_API_KEY'
```

Same for `ENCRYPTION_KEK_B64` (32 bytes, base64), `SESSION_SECRET`, and the optional `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_PROVIDER`, `MODEL_ALLOWLIST_EXTRA`, `EXECUTOR_MODE`, `SANDBOX_BASE_URL`.

## Deploy

Ask David before the first deploy. After that, deploys go through GitHub by pushing. Do not run a production deploy from a laptop outside CI without asking.
