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
        },
      },
    }),
  ],
  test: {
    include: ["test-worker/**/*.test.ts"],
  },
});
