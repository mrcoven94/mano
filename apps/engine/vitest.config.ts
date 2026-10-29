import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          META_MODEL_API_KEY: "test-key-not-real",
          ENCRYPTION_KEK_B64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          SESSION_SECRET: "test-session-secret-not-real",
          MANO_ENV: "development",
          OPERATOR_SECRET: "test-operator-secret-not-real",
          MANO_ENGINE_AGENT_TOKEN: "test-agent-token-not-real",
          MANO_HANDLE_GRANT_SECRET: "test-handle-grant-secret-not-real",
          MANO_ENGINE_CHANNELS_TOKEN: "test-channels-token-not-real",
          MANO_CHANNELS_URL: "https://channels.test",
          MANO_AGENT_SECRET: "test-agent-secret-not-real",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
