import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@mano/channels";
import { routeInLanes } from "../src/index.js";

function message(id: string, body: Partial<NormalizedEvent>) {
  const out = { id, body: { id, ...body }, acked: false, retried: false, ack() { out.acked = true; }, retry() { out.retried = true; } };
  return out;
}

// Maria's chat and Maria's handle both name her one conversation.
const conversations: Record<string, string> = { "chat-maria": "maria", "+15550100": "maria", "chat-b": "b", "chat-c": "c" };
const resolve = async (event: NormalizedEvent) => {
  await new Promise((r) => setTimeout(r, event.id === "m1" ? 10 : 1));
  if (event.id === "dead") throw new Error("route table down");
  return conversations[event.chatId ?? event.handle ?? ""] ?? null;
};

describe("queue batches route in lanes", () => {
  it("delivers one conversation in batch order however its events are addressed, and others at once", async () => {
    const delivered: string[] = [];
    let inFlight = 0;
    let most = 0;
    const batch = [
      message("m1", { chatId: "chat-maria" }),
      message("b1", { chatId: "chat-b" }),
      message("m2", { handle: "+15550100" }),
      message("c1", { chatId: "chat-c" }),
      message("lost", { chatId: "chat-unknown" }),
      message("dead", { chatId: "chat-b" }),
    ];
    await routeInLanes(batch, resolve, async (event, conversation) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (event.id === "b1") throw new Error("down");
      delivered.push(`${conversation}:${event.id}`);
    });
    expect(most).toBe(3);
    expect(delivered.filter((d) => d.startsWith("maria:"))).toEqual(["maria:m1", "maria:m2"]);
    expect(batch.map((m) => [m.id, m.acked, m.retried])).toEqual([
      ["m1", true, false],
      ["b1", false, true],
      ["m2", true, false],
      ["c1", true, false],
      ["lost", true, false],
      ["dead", false, true],
    ]);
  });
});
