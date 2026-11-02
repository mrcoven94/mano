#!/usr/bin/env bash
# Fail the deploy before wrangler runs when a required secret is missing or empty.
# SANDBOX_PORTAL_DRAFT_TOKEN is optional: without it GET /drafts/:id answers 503.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is empty}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is empty}"
: "${SANDBOX_PORTAL_TOKEN:?SANDBOX_PORTAL_TOKEN is empty}"
if [ -n "${SANDBOX_PORTAL_DRAFT_TOKEN:-}" ] && [ "$SANDBOX_PORTAL_DRAFT_TOKEN" = "$SANDBOX_PORTAL_TOKEN" ]; then
  echo "SANDBOX_PORTAL_DRAFT_TOKEN must differ from SANDBOX_PORTAL_TOKEN: the draft token only reads drafts." >&2
  exit 1
fi
