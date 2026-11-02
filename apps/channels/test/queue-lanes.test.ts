import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@mano/channels";
import { routeInLanes } from "../src/index.js";

function message(id: string, body: Partial<NormalizedEvent>) {
  const out = { id, body: { id, ...body }, acked: false, retried: false, ack() { out.acked = true; }, retry() { out.retried = true; } };
  return out;
}

describe("queue batches route in lanes", () => {
  it("runs different chats at once and one chat in batch order", async () => {
    const started: string[] = [];
    let inFlight = 0;
    let most = 0;
    const batch = [
      message("a1", { chatId: "chat-a" }),
      message("b1", { chatId: "chat-b" }),
      message("a2", { chatId: "chat-a" }),
      message("c1", { handle: "+15550100" }),
    ];
    await routeInLanes(batch, async (event) => {
      started.push(event.id);
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (event.id === "b1") throw new Error("down");
    });
    expect(most).toBe(3);
    expect(started.indexOf("a2")).toBeGreaterThan(started.indexOf("a1"));
    expect(batch.map((m) => [m.id, m.acked, m.retried])).toEqual([
      ["a1", true, false],
      ["b1", false, true],
      ["a2", true, false],
      ["c1", true, false],
    ]);
  });
});
