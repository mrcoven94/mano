import { describe, expect, it } from "vitest";
import { changeDraft, holdChatDraft, takeChatDraft } from "../lib/chat-draft";

describe("chat draft handoff", () => {
  it("hands the quoted approval to the same session once", () => {
    holdChatDraft("t-1", changeDraft("About", "File your SNAP renewal", "please change"));
    expect(takeChatDraft("t-1")).toBe('About "File your SNAP renewal": please change ');
    expect(takeChatDraft("t-1")).toBeNull();
  });

  it("never hands a draft to another session", () => {
    holdChatDraft("t-1", "About x");
    expect(takeChatDraft("t-2")).toBeNull();
    expect(takeChatDraft("t-1")).toBeNull();
  });
});
