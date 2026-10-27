// Live smoke: one synthetic request through the real model client.
// Run with a key in the environment (never on a command line):
//   ~/Desktop/code/bin/ws keys run -- pnpm --filter @mano/engine run smoke
// Prints the model, path, latency and status. Never prints the key.
import { MetaModelClient, defaultModelFor } from "../src/model-client.ts";

const key = process.env.META_MODEL_API_KEY;
if (!key) {
  console.error("smoke: META_MODEL_API_KEY is not set.");
  process.exit(1);
}

const client = new MetaModelClient({
  apiKey: key,
  accountId: process.env.CF_ACCOUNT_ID || undefined,
  gatewayId: process.env.AI_GATEWAY_ID || undefined,
  provider: process.env.AI_GATEWAY_PROVIDER || undefined,
  timeoutMs: 30000,
  maxRetries: 1,
});

const started = Date.now();
try {
  const out = await client.complete({
    input: "Connection test with a synthetic prompt. Reply with exactly: ready.",
    synthetic: true,
  });
  console.log(
    JSON.stringify({
      model: out.model,
      via: client.via,
      latencyMs: Date.now() - started,
      status: "ok",
      replyPreview: out.text.slice(0, 80),
    }),
  );
} catch (err) {
  console.log(
    JSON.stringify({
      model: defaultModelFor(true),
      via: client.via,
      latencyMs: Date.now() - started,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
}
