// How the chat screen builds its thread and decides which questions it has
// really shown, apart from the screen so they can be tested.

import { crisisGate } from "@mano/persona/crisis";
import type { ChatMessage } from "./api/types";

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

export function visibleEdges(tokens: { item: ListRow; isViewable: boolean }[]): Set<string> {
  return new Set(tokens.filter((t) => t.isViewable && t.item.kind === "edge").map((t) => t.item.key));
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
