import { defineConfig } from "vitest/config";

// Fetches every source in the catalog again and looks for its quote. Needs
// the network, so it is not part of check: pnpm --filter @mano/programs
// verify-sources. A site that blocks scripted fetches is skipped and named.
export default defineConfig({
  test: {
    include: ["sources/**/*.sources.ts"],
    testTimeout: 60000,
    maxConcurrency: 4,
  },
});
