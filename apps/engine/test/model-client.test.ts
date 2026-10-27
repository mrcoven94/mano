import { describe, expect, it } from "vitest";
import { MetaModelClient } from "../src/model-client.js";

describe("model client", () => {
  it("refuses contributor IDs for non-synthetic data", () => {
    const client = new MetaModelClient({ apiKey: "test-key-not-real" });
    expect(() => client.resolveModel(false, "muse-spark-1.3-contributor")).toThrow();
    expect(client.resolveModel(true)).toContain("contributor");
    expect(client.resolveModel(false)).not.toContain("contributor");
  });
});
