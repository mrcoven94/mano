import { describe, expect, it } from "vitest";
import { boundFetch } from "../src/fetch.js";
import { OpenWeightClient, PrimaryBreaker } from "../src/open-weight.js";
import { SparkResponder } from "../src/responder.js";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const model = process.env.MANO_OPEN_WEIGHT_MODEL || "meta/muse-spark-open";

if (!apiKey) console.log("probe:live open-weight skipped: OPENROUTER_API_KEY is not set.");

// One synthetic text through the real responder with the primary played
// as down (402), so only the fallback call is live.
describe.skipIf(!apiKey)("open-weight fallback, live", () => {
  it("answers a synthetic text from Meta's open-weight model when the primary is down", async () => {
    const fetchFn: typeof fetch = async (input, init) =>
      String(input).startsWith("https://primary.invalid/") ? new Response("{}", { status: 402 }) : boundFetch(input, init);
    const responder = new SparkResponder({
      apiKey: "primary-played-as-down",
      model: "muse-spark-1.3-contributor",
      baseUrl: "https://primary.invalid/v1",
      fetchFn,
      openWeight: { client: new OpenWeightClient({ apiKey, model, fetchFn }), breaker: new PrimaryBreaker() },
    });
    const started = performance.now();
    const result = await responder.respond({ texts: ["Hi, my food benefits letter says my renewal is due. What should I do first?"], attachmentCount: 0 });
    console.log(`open-weight probe: ${Math.round(performance.now() - started)} ms, model ${result.model}, reply: ${result.text.slice(0, 200)}`);
    expect(result.model).toBe(model);
    expect(result.text.length).toBeGreaterThan(0);
  });
});
