import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/api/types";
import { mergeArrived, questionsToAcknowledge } from "../lib/chat-thread";

const message = (id: string, ask?: string): ChatMessage => ({
  id,
  role: "agent",
  text: id,
  createdAt: "2026-11-03T12:00:00.000Z",
  attachments: [],
  status: "sent",
  ...(ask ? { ask: { approvalId: ask } } : {}),
});

describe("mergeArrived", () => {
  it("keeps a reply the conversation could not return, without doubling one it did", () => {
    const merged = mergeArrived([message("a-1")], [message("a-1"), message("crisis-2")]);
    expect(merged.map((m) => m.id)).toEqual(["a-1", "crisis-2"]);
  });

  it("prefers the server's copy, so an acknowledged question stops asking", () => {
    expect(mergeArrived([message("a-1")], [message("a-1", "appr-1")])).toEqual([message("a-1")]);
  });
});

describe("questionsToAcknowledge", () => {
  it("names a displayed question once", () => {
    const thread = [message("a-1"), message("a-2", "appr-1")];
    expect(questionsToAcknowledge(thread, true, new Set())).toEqual([{ approvalId: "appr-1", messageId: "a-2" }]);
    expect(questionsToAcknowledge(thread, true, new Set(["a-2"]))).toEqual([]);
  });

  it("names nothing while the app or tab is in the background, since nobody saw it", () => {
    expect(questionsToAcknowledge([message("a-2", "appr-1")], false, new Set())).toEqual([]);
  });
});
