import { describe, expect, it } from "vitest";
import { MemoryPageStore, pageObjectKey } from "../src/store.js";

describe("MemoryPageStore", () => {
  it("holds bytes by key", async () => {
    const store = new MemoryPageStore();
    expect(await store.get("missing")).toBeNull();
    await store.put("a", new Uint8Array([1, 2, 3]));
    expect(await store.get("a")).toEqual(new Uint8Array([1, 2, 3]));
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });

  it("copies on the way in and out", async () => {
    const store = new MemoryPageStore();
    const input = new Uint8Array([9]);
    await store.put("a", input);
    input[0] = 1;
    expect((await store.get("a"))?.[0]).toBe(9);
  });

  it("names page objects under a versioned prefix", () => {
    expect(pageObjectKey("abc")).toBe("pages/v1/abc.bin");
  });
});
