/// <reference types="node" />
// LAP-1230: a person deletes everything Mano holds about them by text.
// DELETE asks once, a second DELETE within the window runs the delete,
// and anything else in between cancels. Every case runs through the
// runner's own handleEvent and turn path; the delete itself is a stand-in
// that wipes the store the way the Durable Object does.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CRISIS_LINE } from "@mano/persona";
import { OPT_OUT_BUBBLE, type NormalizedEvent } from "@mano/channels";
import { DELETE_CONFIRM_WINDOW_MS, isDeleteRequest } from "../src/runner.js";
import { SqlConversationStore } from "../src/store-sql.js";
import { DELETE_ASK_BUBBLE, DELETE_DONE_BUBBLE, DELETE_PENDING_BUBBLE, INTRO_BUBBLE } from "../src/text.js";
import { TEST_CHAT, TEST_HANDLE, inboundEvent, makeHarness, runTurnAfterBatch, sqliteStorage, type Harness } from "./helpers.js";

interface World {
  h: Harness;
  deletes: number[];
}

function world(opts: { done?: boolean; store?: import("../src/store.js").ConversationStore; startMs?: number } = {}): World {
  const deletes: number[] = [];
  const holder: { h?: Harness } = {};
  const h = makeHarness({
    store: opts.store,
    startMs: opts.startMs,
    deleteConversation: async (cutoffMs: number) => {
      deletes.push(cutoffMs);
      holder.h!.store.wipe(cutoffMs);
      return { done: opts.done ?? true };
    },
  });
  holder.h = h;
  return { h, deletes };
}

let seq = 0;
function text(h: Harness, body: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1;
  return inboundEvent({ id: `evt_del_${seq}`, text: body, occurredAtMs: h.now, ...extra });
}

async function say(h: Harness, body: string, extra: Partial<NormalizedEvent> = {}): Promise<string> {
  return h.runner.handleEvent(text(h, body, extra), "webhook");
}

function sentTexts(h: Harness): string[] {
  return h.channel.sends.map((s) => s.text);
}

describe("the DELETE keyword", () => {
  it("is the whole message, with case and spaces ignored", () => {
    for (const t of ["DELETE", "delete", " Delete ", "de lete", "D E L E T E", "\tdelete\n"]) expect(isDeleteRequest(t)).toBe(true);
    for (const t of ["delete my account", "DELETE.", "deleted", "please delete", "", "del"]) expect(isDeleteRequest(t)).toBe(false);
  });
});

describe("delete by text", () => {
  it("asks once on the first DELETE, says it cannot be undone, and deletes nothing", async () => {
    const { h, deletes } = world();
    h.store.patchMeta({ introduced: true });
    expect(await say(h, " delete ")).toBe("delete-asked");
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE]);
    expect(DELETE_ASK_BUBBLE).toContain("DELETE");
    expect(DELETE_ASK_BUBBLE.toLowerCase()).toContain("cannot be undone");
    expect(deletes).toEqual([]);
    // Nothing waits for a turn: the model never sees the keyword.
    expect(h.store.pending()).toEqual([]);
    h.advance(h.batchMs + 100);
    expect(await h.runner.runDueTurn()).toBe("idle");
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE]);
  });

  it("runs the delete on a second DELETE inside the window and says it is done", async () => {
    const { h, deletes } = world();
    h.store.patchMeta({ introduced: true });
    expect(await say(h, "DELETE")).toBe("delete-asked");
    h.advance(DELETE_CONFIRM_WINDOW_MS - 1000);
    expect(await say(h, "Delete")).toBe("deleted");
    expect(deletes).toHaveLength(1);
    expect(h.store.meta().generation).toBe(1);
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE, DELETE_DONE_BUBBLE]);
    // The done line goes back to the chat the DELETE came from.
    expect(h.channel.sends[1]).toMatchObject({ chatId: TEST_CHAT });
    // Logs carry the hashed handle only, never the number or the words.
    const log = h.lines.join("\n");
    expect(log).toContain("delete_asked");
    expect(log).toContain("delete_confirmed");
    expect(log).not.toContain(TEST_HANDLE);
    expect(log).not.toContain(DELETE_DONE_BUBBLE);
  });

  it("says it is finishing when the delete is still pending", async () => {
    const { h, deletes } = world({ done: false });
    await say(h, "DELETE");
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("deleted");
    expect(deletes).toHaveLength(1);
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE, DELETE_PENDING_BUBBLE]);
  });

  it("asks again when the second DELETE comes after the window", async () => {
    const { h, deletes } = world();
    await say(h, "DELETE");
    h.advance(DELETE_CONFIRM_WINDOW_MS + 1000);
    expect(await say(h, "DELETE")).toBe("delete-asked");
    expect(deletes).toEqual([]);
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE, DELETE_ASK_BUBBLE]);
    // And the fresh ask can be confirmed.
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("deleted");
    expect(deletes).toHaveLength(1);
  });

  it("cancels the pending ask on any other text, which is answered as usual", async () => {
    const { h, deletes } = world();
    h.store.patchMeta({ introduced: true });
    await say(h, "DELETE");
    h.advance(1000);
    expect(await say(h, "actually never mind")).toBe("queued");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)).toHaveLength(2);
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("delete-asked");
    expect(deletes).toEqual([]);
  });

  it("never confirms on a photo or a voice note, even one captioned DELETE, and either cancels", async () => {
    const photo = [{ url: "https://bucket.blooio.com/a/letter.jpg", mediaType: "image/jpeg", name: "letter.jpg", size: 1000 }];
    const voice = [{ url: "https://bucket.blooio.com/a/voice.m4a", mediaType: "audio/x-m4a", name: "Audio Message.m4a", size: 1000 }];
    for (const attachments of [photo, voice]) {
      for (const caption of ["DELETE", null]) {
        const { h, deletes } = world();
        h.store.patchMeta({ introduced: true });
        await say(h, "DELETE");
        h.advance(1000);
        expect(await say(h, caption as string, { text: caption, attachments })).toBe("queued");
        expect(deletes).toEqual([]);
        expect(h.store.meta().deleteAskedAtMs).toBe(0);
        h.advance(1000);
        expect(await say(h, "DELETE")).toBe("delete-asked");
        expect(deletes).toEqual([]);
      }
    }
  });

  it("never confirms on a reaction, and a reaction cancels", async () => {
    const { h, deletes } = world();
    await say(h, "DELETE");
    h.advance(1000);
    const reaction: NormalizedEvent = {
      ...text(h, ""),
      kind: "reaction",
      rawType: "message.reaction",
      text: null,
      messageId: h.channel.sends[0].messageId ?? "msg_x",
      reaction: { value: "like", action: "add" },
    };
    expect(await h.runner.handleEvent(reaction, "webhook")).toBe("activity");
    expect(h.store.meta().deleteAskedAtMs).toBe(0);
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("delete-asked");
    expect(deletes).toEqual([]);
  });

  it("never asks or confirms on a DELETE older than the inbound age limit, or with no date", async () => {
    const { h, deletes } = world();
    await say(h, "DELETE");
    h.advance(60_000);
    const limit = 5 * 60 * 1000;
    expect(await say(h, "DELETE", { occurredAtMs: h.now - limit - 1000 })).toBe("stale");
    expect(await say(h, "DELETE", { occurredAtMs: null })).toBe("quarantined");
    expect(deletes).toEqual([]);
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE]);
    // A stale first DELETE never asks either.
    const other = world();
    expect(await say(other.h, "DELETE", { occurredAtMs: other.h.now - limit - 1000 })).toBe("stale");
    expect(sentTexts(other.h)).toEqual([]);
  });

  it("never confirms with the same DELETE delivered twice", async () => {
    const { h, deletes } = world();
    const first = text(h, "DELETE");
    expect(await h.runner.handleEvent(first, "webhook")).toBe("delete-asked");
    // The reconcile feed: another event ID for the same message.
    expect(await h.runner.handleEvent({ ...first, id: `${first.id}_feed` }, "reconcile")).toBe("duplicate");
    // The same instant under another message ID is not a second DELETE.
    expect(await h.runner.handleEvent({ ...first, id: `${first.id}_b`, messageId: "msg_other" }, "webhook")).toBe("delete-asked");
    expect(deletes).toEqual([]);
  });

  it("drops a redelivery of the confirming DELETE after the wipe", async () => {
    const { h, deletes } = world();
    await say(h, "DELETE");
    h.advance(1000);
    const confirm = text(h, "DELETE");
    expect(await h.runner.handleEvent(confirm, "webhook")).toBe("deleted");
    // Even a provider clock a little ahead of ours cannot slip past the cutoff.
    expect(deletes[0]).toBeGreaterThan(confirm.occurredAtMs!);
    h.advance(1000);
    expect(await h.runner.handleEvent(confirm, "webhook")).toBe("dropped");
    // The feed's copy dedupes on the message ID the redelivery recorded.
    expect(await h.runner.handleEvent({ ...confirm, id: `${confirm.id}_feed` }, "reconcile")).toBe("duplicate");
    expect(deletes).toHaveLength(1);
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE, DELETE_DONE_BUBBLE]);
  });

  it("makes the next text a fresh first contact", async () => {
    const { h } = world();
    await say(h, "hi");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)[0]).toBe(INTRO_BUBBLE);
    expect(h.store.meta().introduced).toBe(true);
    h.advance(1000);
    await say(h, "DELETE");
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("deleted");
    expect(h.store.meta().introduced).toBe(false);
    h.advance(1000);
    const before = h.channel.sends.length;
    expect(await say(h, "hi")).toBe("queued");
    await runTurnAfterBatch(h);
    expect(sentTexts(h).slice(before)[0]).toBe(INTRO_BUBBLE);
  });

  it("keeps the crisis floor: a crisis text cancels the ask and gets the crisis line", async () => {
    const { h, deletes } = world();
    h.store.patchMeta({ introduced: true });
    await say(h, "DELETE");
    h.advance(1000);
    expect(await say(h, "I want to kill myself")).toBe("queued");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)[1]).toBe(CRISIS_LINE);
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("delete-asked");
    expect(deletes).toEqual([]);
  });

  it("keeps the crisis floor: a crisis text the delete would wipe unanswered gets the crisis line first", async () => {
    const { h, deletes } = world();
    h.store.patchMeta({ introduced: true });
    // All three land inside one batch window, before any turn runs.
    await say(h, "I want to kill myself");
    h.advance(200);
    await say(h, "DELETE");
    h.advance(200);
    expect(await say(h, "DELETE")).toBe("deleted");
    expect(deletes).toHaveLength(1);
    expect(sentTexts(h)).toEqual([DELETE_ASK_BUBBLE, CRISIS_LINE, DELETE_DONE_BUBBLE]);
  });

  it("leaves STOP as it was, and STOP cancels a pending ask", async () => {
    const { h, deletes } = world();
    expect(await say(h, "STOP")).toBe("opted-out");
    expect(sentTexts(h)).toEqual([OPT_OUT_BUBBLE]);
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("delete-asked");
    h.advance(1000);
    expect(await say(h, "STOP")).toBe("opted-out");
    expect(h.store.meta().deleteAskedAtMs).toBe(0);
    h.advance(1000);
    expect(await say(h, "DELETE")).toBe("delete-asked");
    expect(deletes).toEqual([]);
  });

  it("keeps the per-person send counters across the delete", async () => {
    const { h } = world();
    await say(h, "DELETE");
    h.advance(1000);
    const before = h.store.meta();
    expect(before.dayCount).toBeGreaterThan(0);
    await say(h, "DELETE");
    const after = h.store.meta();
    expect(after.dayKey).toBe(before.dayKey);
    expect(after.dayCount).toBeGreaterThan(before.dayCount);
    expect(after.hourCount).toBeGreaterThan(before.hourCount);
  });

  it("keeps a pending ask in SQLite across a restart", async () => {
    const db = new DatabaseSync(":memory:");
    const first = world({ store: new SqlConversationStore(sqliteStorage(db)) });
    await say(first.h, "DELETE");
    const askedAt = first.h.store.meta().deleteAskedAtMs;
    expect(askedAt).toBeGreaterThan(0);
    // A restarted worker opens the same database.
    const second = world({ store: new SqlConversationStore(sqliteStorage(db)), startMs: first.h.now + 1000 });
    expect(second.h.store.meta().deleteAskedAtMs).toBe(askedAt);
    expect(await say(second.h, "DELETE")).toBe("deleted");
    expect(second.deletes).toHaveLength(1);
    expect(second.h.store.meta().deleteAskedAtMs).toBe(0);
  });
});
