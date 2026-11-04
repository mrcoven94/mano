import { defineConfig } from "vitest/config";

// Live persona probes against the real model API. Run with a key in the
// environment: pnpm --filter @mano/channels probe:live. Without
// META_MODEL_API_KEY the persona probes are skipped, and without
// OPENROUTER_API_KEY the open-weight fallback probe is. Probes send
// synthetic text only, so they use a -contributor model ID.
export default defineConfig({
  test: {
    include: ["probe/**/*.probe.ts"],
    testTimeout: 600000,
    silent: false,
    env: {
      MANO_PROBE_MODEL: process.env.MANO_PROBE_MODEL ?? "muse-spark-1.3-contributor",
    },
  },
});
