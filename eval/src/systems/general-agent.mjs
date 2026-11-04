// System entry: general agent (real model run with tool loop).
// Reads baseline inputs, writes outputs.
// Usage: node general-agent.mjs --input <json> --out <json>
// The child is offline: model calls travel through the parent broker over
// IPC. Without a brokered key every household reports "not run".
import { readFile, writeFile } from "node:fs/promises";
import { generalAgentBaseline } from "../baselines.mjs";
import { childBroker } from "../ipc.mjs";
import { mapPool } from "../pool.mjs";

const CONCURRENT_HOUSEHOLDS = 8;

const args = process.argv.slice(2);
const inputPath = args[args.indexOf("--input") + 1];
const outPath = args[args.indexOf("--out") + 1];
const inputs = JSON.parse(await readFile(inputPath, "utf8"));
const brokerFetch = childBroker({ timeoutMs: 180000 });
let brokered = false;
let route = null;
if (brokerFetch) {
  const hello = await brokerFetch.hello();
  brokered = hello.keyAvailable === true;
  route = hello.route;
}
const outputs = await mapPool(inputs, CONCURRENT_HOUSEHOLDS, async (h) => {
  try {
    return await generalAgentBaseline(h, brokered ? { fetchImpl: brokerFetch, brokered: true, route: route ?? "meta" } : {});
  } catch (err) {
    return {
      householdId: h.householdId,
      baseline: "general-agent",
      status: "error",
      reason: String((err && err.message) || err).slice(0, 200),
      reminders: [],
      packet: [],
      refused: [],
      enforced: [],
      requested: [],
      failures: [{ letterId: "*", reason: "system_threw" }],
      toolCalls: [],
      costUsd: 0,
      elapsedMs: 0,
    };
  }
});
await writeFile(outPath, JSON.stringify(outputs));
