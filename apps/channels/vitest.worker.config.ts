import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          BLOOIO_API_KEY: "",
          BLOOIO_CHANNEL_ID: "ch_test_line",
          BLOOIO_WEBHOOK_SECRET: "test-webhook-secret-not-real",
          MANO_HANDLE_PEPPER: "test-pepper-not-real",
          ENCRYPTION_KEK_B64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          MANO_TEXT_NUMBER: "+18005550000",
          // A closed port: Engine never answers, so a delete stays pending.
          MANO_ENGINE_URL: "http://127.0.0.1:9",
          MANO_ENGINE_CHANNELS_TOKEN: "test-engine-channels-token-not-real",
          MANO_HANDLE_GRANT_SECRET: "test-grant-secret-not-real",
        },
      },
    }),
  ],
  test: {
    include: ["test-worker/**/*.test.ts"],
  },
});
