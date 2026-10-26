# Mano engine

Cloudflare Worker with one Durable Object per person and per organization.

## Run locally

```bash
pnpm --filter @mano/engine dev
```

## Secrets

Never put a key on a command line. Set secrets from stdin:

```bash
~/Desktop/code/bin/ws keys run -- sh -c 'printf %s "$META_MODEL_API_KEY" | pnpm --filter @mano/engine exec wrangler secret put META_MODEL_API_KEY'
```

Generate an encryption key (32 bytes, base64) and set it the same way as `ENCRYPTION_KEK_B64`.

## Deploy

Ask David before the first deploy. After that:

```bash
pnpm --filter @mano/engine deploy
```

Deploys go through GitHub by pushing. Do not run a production deploy from a laptop outside CI without asking.

## HTTP surface

- `GET /health`
- `GET /api/persons/:id/approvals` (header `x-person-id` must match `:id`)
- `POST /api/persons/:id/chat`
- `POST /api/persons/:id/action` (goes through the action gateway)
- `GET /api/persons/:id/ws` (WebSocket upgrade, same identity rule)
- `GET /api/orgs/:id/cases`, `POST /api/orgs/:id/share`
- `POST /api/check-link` with `{ url, forDisplay }`
