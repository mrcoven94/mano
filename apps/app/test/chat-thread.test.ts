import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/api/types";
import { canSend, crisisNoticeFor, deviceCrisisId, edgeKey, visibleMessageIds, inDisplayOrder, isMailSend, listRows, mergeArrived, pendingMessages, questionsToAcknowledge, showsThread, threadView, visibleEdges } from "../lib/chat-thread";
import type { QueuedMessage } from "../lib/queue";

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

describe("crisisNoticeFor", () => {
  const line = (id: string): ChatMessage => ({ ...message(id), text: `988 and 911 ${id}` });
  const first = deviceCrisisId("2026-11-03T12:00:00.000Z");
  const second = deviceCrisisId("2026-11-03T12:05:00.000Z");

  it("shows the fixed line, in the same words, for a crisis reply not yet on screen", () => {
    expect(crisisNoticeFor([message("a-1"), line(first)], new Set())).toEqual({ id: first, text: `988 and 911 ${first}` });
  });

  it("clears once the person has scrolled to it or dismissed it", () => {
    expect(crisisNoticeFor([line(first)], new Set([first]))).toBeNull();
  });

  it("follows only the newest crisis reply", () => {
    expect(crisisNoticeFor([line(first), line(second)], new Set([second]))).toBeNull();
    expect(crisisNoticeFor([line(first), line(second)], new Set([first]))?.id).toBe(second);
  });

  it("shows nothing when there is no crisis reply", () => {
    expect(crisisNoticeFor([message("a-1")], new Set())).toBeNull();
  });
});

describe("visibleMessageIds", () => {
  it("counts only message rows the list says are viewable", () => {
    const rows = listRows([message("a-2", "appr-1"), message("a-1")]);
    const tokens = rows.map((item) => ({ item, isViewable: item.key !== "a-1" }));
    expect([...visibleMessageIds(tokens)]).toEqual(["a-2"]);
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

describe("threadView", () => {
  it("shows a loading view, not the empty card, until the first read finishes", () => {
    expect(threadView([], false)).toBe("loading");
    expect(threadView([], true)).toBe("empty");
  });

  it("shows a queued message or crisis line at once, even while loading", () => {
    expect(threadView([message("crisis")], false)).toBe("thread");
  });
});

describe("mail on its way", () => {
  const queuedItem = (id: string): QueuedMessage => ({
    id,
    personId: "alice",
    text: "mail",
    attachments: [{ kind: "photo", name: "m.jpg", mimeType: "image/jpeg", bytesB64: "AA==" }],
    createdAt: "2026-11-03T12:00:00.000Z",
    attempts: 0,
  });

  it("counts photos and video as mail, and a voice note or plain text as not", () => {
    expect(isMailSend([{ kind: "photo" }])).toBe(true);
    expect(isMailSend([{ kind: "video" }])).toBe(true);
    expect(isMailSend([{ kind: "voice" }])).toBe(false);
    expect(isMailSend([])).toBe(false);
  });

  it("never labels the mail on its way as waiting for a connection, and lists it once", () => {
    const rows = pendingMessages([queuedItem("q-1"), queuedItem("q-2")], { item: queuedItem("q-1"), answered: false });
    expect(rows.map((m) => [m.id, m.status])).toEqual([
      ["q-2", "queued"],
      ["q-1", "sending"],
    ]);
  });

  it("puts failed mail back to waiting once nothing is on its way", () => {
    expect(pendingMessages([queuedItem("q-1")], null).map((m) => m.status)).toEqual(["queued"]);
  });

  it("keeps answered mail on screen with no waiting label until the thread is read again", () => {
    expect(pendingMessages([], { item: queuedItem("q-1"), answered: true }).map((m) => [m.id, m.status])).toEqual([["q-1", "sending"]]);
  });
});
