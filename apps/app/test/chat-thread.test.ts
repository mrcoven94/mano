import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/api/types";
import { canSend, edgeKey, inDisplayOrder, listRows, mergeArrived, questionsToAcknowledge, showsThread, visibleEdges } from "../lib/chat-thread";

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
  const seen = (...keys: string[]) => new Set(keys);
  const top = edgeKey("a-2", "top");
  const bottom = edgeKey("a-2", "bottom");

  it("names a question once both its edges have been seen, and only once", () => {
    const thread = [message("a-1"), message("a-2", "appr-1")];
    expect(questionsToAcknowledge(thread, seen(top, bottom), true, new Set())).toEqual([{ approvalId: "appr-1", messageId: "a-2" }]);
    expect(questionsToAcknowledge(thread, seen(top, bottom), true, new Set(["a-2"]))).toEqual([]);
  });

  it("names nothing when only one edge of a tall question has been on screen", () => {
    expect(questionsToAcknowledge([message("a-2", "appr-1")], seen(top), true, new Set())).toEqual([]);
    expect(questionsToAcknowledge([message("a-2", "appr-1")], seen(bottom), true, new Set())).toEqual([]);
  });

  it("names nothing for a question loaded in the thread but never scrolled to", () => {
    expect(questionsToAcknowledge([message("a-1"), message("a-2", "appr-1")], seen(), true, new Set())).toEqual([]);
  });

  it("names nothing while the app or tab is in the background, since nobody saw it", () => {
    expect(questionsToAcknowledge([message("a-2", "appr-1")], seen(top, bottom), false, new Set())).toEqual([]);
  });
});

describe("listRows", () => {
  it("brackets only a message with a question between its two edges, for a list drawn bottom up", () => {
    const rows = listRows([message("a-2", "appr-1"), message("a-1")]);
    expect(rows.map((r) => r.key)).toEqual([edgeKey("a-2", "bottom"), "a-2", edgeKey("a-2", "top"), "a-1"]);
  });
});

describe("visibleEdges", () => {
  it("counts only edge rows the list says are viewable", () => {
    const rows = listRows([message("a-2", "appr-1")]);
    const tokens = rows.map((item, i) => ({ item, isViewable: i !== 2 }));
    expect([...visibleEdges(tokens)]).toEqual([edgeKey("a-2", "bottom")]);
  });
});

describe("canSend", () => {
  it("waits for a send in progress, except for a message naming a crisis", () => {
    expect(canSend("Hi", false)).toBe(true);
    expect(canSend("Hi", true)).toBe(false);
    expect(canSend("   ", false)).toBe(false);
    expect(canSend("I want to kill myself", true)).toBe(true);
  });
});

describe("showsThread", () => {
  it("shows anything local at once, even while the conversation is still loading", () => {
    expect(showsThread([message("device-crisis-1")])).toBe(true);
    expect(showsThread([])).toBe(false);
  });
});

describe("inDisplayOrder", () => {
  it("puts a line shown on the device after the queued message that prompted it", () => {
    const at = (id: string, createdAt: string): ChatMessage => ({ ...message(id), createdAt });
    const ordered = inDisplayOrder([at("a-1", "2026-11-03T12:00:00.000Z"), at("device-crisis", "2026-11-03T12:05:01.000Z")], [at("q-1", "2026-11-03T12:05:00.000Z")]);
    expect(ordered.map((m) => m.id)).toEqual(["a-1", "q-1", "device-crisis"]);
  });
});
