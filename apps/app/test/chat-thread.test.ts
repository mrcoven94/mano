import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/api/types";
import { inDisplayOrder, mergeArrived, questionsToAcknowledge, visibleMessageIds } from "../lib/chat-thread";

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
  const visible = (...ids: string[]) => new Set(ids);

  it("names a question on screen once", () => {
    const thread = [message("a-1"), message("a-2", "appr-1")];
    expect(questionsToAcknowledge(thread, visible("a-1", "a-2"), true, new Set())).toEqual([{ approvalId: "appr-1", messageId: "a-2" }]);
    expect(questionsToAcknowledge(thread, visible("a-2"), true, new Set(["a-2"]))).toEqual([]);
  });

  it("names nothing for a question loaded in the thread but scrolled out of view", () => {
    expect(questionsToAcknowledge([message("a-1"), message("a-2", "appr-1")], visible("a-1"), true, new Set())).toEqual([]);
  });

  it("names nothing while the app or tab is in the background, since nobody saw it", () => {
    expect(questionsToAcknowledge([message("a-2", "appr-1")], visible("a-2"), false, new Set())).toEqual([]);
  });
});

describe("visibleMessageIds", () => {
  it("counts only rows the list says are viewable", () => {
    const tokens = [
      { item: message("a-1"), isViewable: true },
      { item: message("a-2"), isViewable: false },
    ];
    expect([...visibleMessageIds(tokens)]).toEqual(["a-1"]);
  });
});

describe("inDisplayOrder", () => {
  it("puts a line shown on the device after the queued message that prompted it", () => {
    const at = (id: string, createdAt: string): ChatMessage => ({ ...message(id), createdAt });
    const ordered = inDisplayOrder([at("a-1", "2026-11-03T12:00:00.000Z"), at("device-crisis", "2026-11-03T12:05:01.000Z")], [at("q-1", "2026-11-03T12:05:00.000Z")]);
    expect(ordered.map((m) => m.id)).toEqual(["a-1", "q-1", "device-crisis"]);
  });
});
