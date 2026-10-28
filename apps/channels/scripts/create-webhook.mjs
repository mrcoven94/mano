// Creates Mano's channel-scoped Blooio webhook pointing at the deployed
// channels worker, then pipes the signing secret straight into the key
// store without printing it. Run: pnpm --filter channels webhook:create
// with BLOOIO_API_KEY, BLOOIO_CHANNEL_ID and CHANNELS_WORKER_URL in the
// environment (ws keys run). It only creates; it never lists, changes or
// deletes any webhook.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const { BLOOIO_API_KEY, BLOOIO_CHANNEL_ID, CHANNELS_WORKER_URL } = process.env;
if (!BLOOIO_API_KEY || !BLOOIO_CHANNEL_ID || !CHANNELS_WORKER_URL) {
  console.error("Missing env: BLOOIO_API_KEY, BLOOIO_CHANNEL_ID and CHANNELS_WORKER_URL are all required.");
  process.exit(1);
}

const url = `${CHANNELS_WORKER_URL.replace(/\/$/, "")}/webhooks/blooio`;
const res = await fetch("https://api.blooio.com/v4/webhooks", {
  method: "POST",
  headers: { authorization: `Bearer ${BLOOIO_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ url, channel_id: BLOOIO_CHANNEL_ID, api_version: "2026-10-01" }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Webhook create failed: ${res.status} ${(data && data.code) || ""}`);
  process.exit(1);
}
const id = data && data.data && data.data.id;
const secret = data && data.data && data.data.signing_secret;
if (!id || !secret) {
  console.error("Webhook create returned no id or signing secret.");
  process.exit(1);
}

const wsBin = process.env.WS_KEYS_BIN ?? path.join(os.homedir(), "Desktop/code/bin/ws");
const stored = spawnSync(wsBin, ["keys", "set", "BLOOIO_WEBHOOK_SECRET"], { input: secret, encoding: "utf8" });
if (stored.status !== 0) {
  console.error(`Storing BLOOIO_WEBHOOK_SECRET failed. Rotate the webhook secret; the printed id is ${id}.`);
  process.exit(1);
}
console.log(`Webhook ${id} created for ${url} and scoped to channel ${BLOOIO_CHANNEL_ID}.`);
console.log("Signing secret stored as BLOOIO_WEBHOOK_SECRET (not printed).");
