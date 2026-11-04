import { defineConfig } from "vitest/config";

// The live probe. It spends real model credit, so it runs only when asked:
// pnpm --filter @mano/computer probe:live. Without OPENROUTER_API_KEY it is
// skipped. It sends screenshots of a synthetic form only.
export default defineConfig({
  test: {
    include: ["probe/**/*.probe.ts"],
    testTimeout: 180000,
    silent: false,
  },
});
