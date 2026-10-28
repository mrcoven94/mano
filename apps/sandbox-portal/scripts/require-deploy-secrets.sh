#!/usr/bin/env bash
# Fail the deploy before wrangler runs when a required secret is missing or empty.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is empty}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is empty}"
: "${SANDBOX_PORTAL_TOKEN:?SANDBOX_PORTAL_TOKEN is empty}"
