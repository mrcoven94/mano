import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_BINDINGS } from "./vitest.config.js";

// The Engine Worker with Guardian configured, for the route tests in
// test-guardian. The Guardian URL is answered by a stubbed fetch there.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ...TEST_BINDINGS,
          MANO_GUARDIAN_URL: "https://guardian.test/check",
          MANO_GUARDIAN_TOKEN: "guardian-token-not-real",
          MANO_GUARDIAN_KEY_ID: "modal-key-not-real",
          MANO_GUARDIAN_KEY_SECRET: "modal-secret-not-real",
        },
      },
    }),
  ],
  test: {
    include: ["test-guardian/**/*.test.ts"],
  },
});
