# Contributing

Thanks for helping. Read `AGENTS.md` and `docs/decisions.md` first; they apply to people and to coding agents alike.

## Run it locally

You do not need our accounts. Every package runs with local stand-ins when its keys are missing (a fake model client, an in-memory database, a local link check), and says clearly which parts are not live. Copy each package's `.env.example` to `.dev.vars` or `.env` to use your own keys.

```sh
pnpm install
pnpm check
```

## Rules that matter most

- Synthetic people only. No real names, documents, case numbers or phone numbers anywhere.
- Every outside action goes through the action gateway, with an approval bound to the exact document.
- Mano never presents itself as a human.
- Plain language in anything a person reads. No em dashes.

## Pull requests

Small, focused, with tests for anything that sends, submits or shares. `pnpm check` must pass. If `pnpm-lock.yaml` conflicts, rebase on `main` and run `pnpm install` again.
