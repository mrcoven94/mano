// How the chat screen builds its thread and decides which questions it has
// really shown, apart from the screen so they can be tested.

import { crisisGate } from "@mano/persona/crisis";
import type { ChatMessage, NewAttachment } from "./api/types";
import type { QueuedMessage } from "./queue";

// A reply that came back from a send but not from the conversation stays
// on screen: a crisis line must show even when the conversation cannot be
// read. The server's copy of a message always wins.
export function mergeArrived(server: ChatMessage[], arrived: ChatMessage[]): ChatMessage[] {
  const known = new Set(server.map((m) => m.id));
  return [...server, ...arrived.filter((m) => !known.has(m.id))];
}

export interface QuestionShown {
  approvalId: string;
  messageId: string;
}

// A list row: a message, or a one-pixel marker at the top or bottom of a
// message that asks a question. The list itself reports when a marker is on
// screen, so nothing here measures layout and an inverted list needs no
// special case. A short question has both markers on screen at once; a tall
// one has them on screen in turn, as the person scrolls.
export type QuestionEdge = "top" | "bottom";
export type ListRow = { kind: "message"; key: string; message: ChatMessage } | { kind: "edge"; key: string };

export const EDGE_ON_SCREEN = { itemVisiblePercentThreshold: 100 };

export const edgeKey = (messageId: string, edge: QuestionEdge): string => `${messageId}#${edge}`;

// Takes messages newest first, as the inverted list draws them from the
// bottom up, so each message's bottom marker comes before it in the array.
export function listRows(newestFirst: ChatMessage[]): ListRow[] {
  return newestFirst.flatMap((message): ListRow[] => {
    const row: ListRow = { kind: "message", key: message.id, message };
    if (!message.ask) return [row];
    return [{ kind: "edge", key: edgeKey(message.id, "bottom") }, row, { kind: "edge", key: edgeKey(message.id, "top") }];
  });
}

export function visibleMessageIds(tokens: { item: ListRow; isViewable: boolean }[]): Set<string> {
  return new Set(tokens.filter((t) => t.isViewable && t.item.kind === "message").map((t) => t.item.key));
}

export function visibleEdges(tokens: { item: ListRow; isViewable: boolean }[]): Set<string> {
  return new Set(tokens.filter((t) => t.isViewable && t.item.kind === "edge").map((t) => t.item.key));
}

const DEVICE_CRISIS_PREFIX = "device-crisis-";

export const deviceCrisisId = (createdAt: string): string => `${DEVICE_CRISIS_PREFIX}${createdAt}`;

// The fixed line to pin above the composer: a person scrolled into history
// would not otherwise see a crisis reply added at the bottom. It stays until
// the newest crisis reply has been on screen or the person dismisses it.
export function crisisNoticeFor(thread: ChatMessage[], settled: ReadonlySet<string>): { id: string; text: string } | null {
  const newest = thread.filter((m) => m.id.startsWith(DEVICE_CRISIS_PREFIX)).at(-1);
  return newest && !settled.has(newest.id) ? { id: newest.id, text: newest.text } : null;
}

// One send at a time, except that a slow send never holds back a message
// naming a crisis: sending it is what puts the numbers on screen.
export function canSend(text: string, sending: boolean): boolean {
  return text.trim().length > 0 && (!sending || crisisGate(text) !== "none");
}

// The empty card only when there is truly nothing to show: a queued message
// or a crisis line appears at once, even while the conversation still loads.
export function showsThread(messages: ChatMessage[]): boolean {
  return messages.length > 0;
}

// What fills the chat: the thread when there is anything to show, a loading
// view until the first read of the conversation has finished, and only then
// the empty card, so it never stands in for a thread still on its way.
export function threadView(messages: ChatMessage[], loaded: boolean): "thread" | "loading" | "empty" {
  if (showsThread(messages)) return "thread";
  return loaded ? "empty" : "loading";
}

// Mail is anything but a voice note: the working line talks about mail.
export function isMailSend(attachments: readonly Pick<NewAttachment, "kind">[]): boolean {
  return attachments.some((a) => a.kind !== "voice");
}

// Mail on its way, and kept on screen once answered until the conversation
// has been read again, so it does not blink out in between.
export interface OutgoingMail {
  item: QueuedMessage;
  answered: boolean;
}

function asMessage(q: QueuedMessage, status: ChatMessage["status"]): ChatMessage {
  return {
    id: q.id,
    role: "user",
    text: q.text,
    createdAt: q.createdAt,
    attachments: q.attachments.map((a, i) => ({
      id: `${q.id}-att-${i}`,
      kind: a.kind,
      name: a.name,
      mimeType: a.mimeType,
      size: a.bytesB64.length,
    })),
    status,
  };
}

// The person's own messages the conversation does not hold yet. The one on
// its way is not "waiting for connection", even while the outbox still lists
// it, and a failed one is simply back to waiting.
export function pendingMessages(queued: readonly QueuedMessage[], outgoing: OutgoingMail | null): ChatMessage[] {
  const waiting = queued.filter((q) => q.id !== outgoing?.item.id).map((q) => asMessage(q, "queued"));
  return outgoing ? [...waiting, asMessage(outgoing.item, "sending")] : waiting;
}

// The questions the person has read in this viewing that the server has not
// heard about: both edges seen, with the app or tab in the foreground.
export function questionsToAcknowledge(
  thread: ChatMessage[],
  seen: ReadonlySet<string>,
  appActive: boolean,
  alreadySent: ReadonlySet<string>,
): QuestionShown[] {
  if (!appActive) return [];
  return thread.flatMap((m) =>
    m.ask && !alreadySent.has(m.id) && seen.has(edgeKey(m.id, "top")) && seen.has(edgeKey(m.id, "bottom"))
      ? [{ approvalId: m.ask.approvalId, messageId: m.id }]
      : [],
  );
}

// Sent, waiting and device-only messages in the order they happened. The
// sort is stable, so messages from the same moment keep their places.
export function inDisplayOrder(thread: ChatMessage[], queued: ChatMessage[]): ChatMessage[] {
  const at = (m: ChatMessage): number => new Date(m.createdAt).getTime();
  return [...thread, ...queued].sort((a, b) => at(a) - at(b));
}
