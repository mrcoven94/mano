# Sandbox portal

A fake state benefits portal that every Mano demo submits to. Mano never touches a real benefits site; it practices here. It is a Cloudflare Worker with Durable Object storage, so anyone can deploy their own copy.

## What it does

- A three-step renewal application: household information, document uploads (PDF, PNG, JPG), review and submit.
- A session timeout: idle sessions end and must start over. Nothing is submitted on timeout.
- A confirmation number (`SR-` plus 8 characters) for every accepted application.
- One deliberately old-looking design: gray tables, small Verdana, a 760px page.
- Every submission carries an idempotency key. `GET /submissions/:key` reports `received` or `not_found`, so the action gateway reconciles after a timeout instead of submitting twice. Resubmitting a key returns the original confirmation; no duplicate is filed.
- Slow mode holds the submit response past the caller's timeout (the application is stored first). Turn it on with the checkbox on the review page, `?slow=1`, or `slowMs` in a JSON call. Default hold is 20 seconds.
- A caseworker view at `/caseworker` lists submissions with detail pages and file downloads. The Spine session uses it as the older system staff work in.
- Every page is labeled as a test system.

## Run it

```sh
pnpm install
pnpm --filter @mano/sandbox-portal dev
```

`wrangler dev` serves the portal locally with a local Durable Object. Copy `.env.example` to `.dev.vars` to change the session timeout, the slow-mode default, or the upload limits.

Deploy your own copy:

```sh
pnpm --filter @mano/sandbox-portal deploy
```

## API

- `POST /submissions` with JSON `{ key, household, files: [{ name, type, data }] }` where `data` is base64. Returns `{ key, status, confirmationNumber, receivedAt, duplicate }`.
- `GET /submissions/:key` returns the receipt or `{ status: "not_found" }` with a 404.

The web form posts the same fields as a form and returns HTML pages instead.

## Test

```sh
pnpm --filter @mano/sandbox-portal check
```

Typecheck plus vitest. Tests run against an in-memory store; no Cloudflare account needed.
