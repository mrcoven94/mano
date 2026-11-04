// How the chat screen builds its thread and decides which questions it has
// really shown, apart from the screen so they can be tested.

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

// How long and how much of a row must be on screen to count as seen: all
// of it, for long enough that scrolling past it does not count. A question
// too tall to fit stays unacknowledged, which fails closed: a YES to it is
// not taken, and Mano asks again.
export const SEEN_ROW = { itemVisiblePercentThreshold: 100, minimumViewTime: 500 };

export function visibleMessageIds(rows: { item: ChatMessage; isViewable: boolean }[]): Set<string> {
  return new Set(rows.filter((r) => r.isViewable).map((r) => r.item.id));
}

// The questions the person can see now that the server has not heard about.
// A question loaded in the thread but scrolled away does not count, and
// nothing counts while the app or tab is in the background.
export function questionsToAcknowledge(
  thread: ChatMessage[],
  visible: ReadonlySet<string>,
  appActive: boolean,
  alreadySent: ReadonlySet<string>,
): QuestionShown[] {
  if (!appActive) return [];
  return thread.flatMap((m) => (m.ask && visible.has(m.id) && !alreadySent.has(m.id) ? [{ approvalId: m.ask.approvalId, messageId: m.id }] : []));
}

// Sent, waiting and device-only messages in the order they happened. The
// sort is stable, so messages from the same moment keep their places.
export function inDisplayOrder(thread: ChatMessage[], queued: ChatMessage[]): ChatMessage[] {
  const at = (m: ChatMessage): number => new Date(m.createdAt).getTime();
  return [...thread, ...queued].sort((a, b) => at(a) - at(b));
}
