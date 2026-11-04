// System entry: Mano's letter reader. Bundled with @mano/mail before the run
// (see build-mano.mjs) because the child reads only its run directory.
// Usage: node mano.mjs --input <json> --out <json>
// Offline like every system: model calls and link checks go through the
// parent broker. Without a brokered key every household reports "not run".
import { readFile, writeFile } from "node:fs/promises";
import { manoHousehold } from "../mano-adapter.mjs";
import { childBroker } from "../ipc.mjs";
import { mapPool } from "../pool.mjs";

const CONCURRENT_HOUSEHOLDS = 8;
const args = process.argv.slice(2);
const inputPath = args[args.indexOf("--input") + 1];
const outPath = args[args.indexOf("--out") + 1];
const inputs = JSON.parse(await readFile(inputPath, "utf8"));
const broker = childBroker({ timeoutMs: 180000 });
const hello = broker ? await broker.hello() : { keyAvailable: false };
const shell = (h, status, reason) => ({
  householdId: h.householdId,
  baseline: "mano",
  status,
  reason,
  reminders: [],
  packet: [],
  actions: [],
  refused: [],
  enforced: [],
  requested: [],
  failures: status === "error" ? [{ letterId: "*", reason: "system_threw" }] : [],
  toolCalls: [],
  costUsd: null,
  elapsedMs: 0,
});
let outputs;
if (!hello.keyAvailable) {
  outputs = inputs.map((h) => shell(h, "not run", "no model key"));
} else {
  const { default: sharp } = await import("sharp");
  outputs = await mapPool(inputs, CONCURRENT_HOUSEHOLDS, async (h) => {
    try {
      return await manoHousehold(h, { route: hello.route, fetchImpl: broker, sharp });
    } catch {
      return shell(h, "error", "household failed");
    }
  });
}
await writeFile(outPath, JSON.stringify(outputs));
