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

// The questions on screen that the server has not heard about. Nothing
// counts while the app or tab is in the background.
export function questionsToAcknowledge(thread: ChatMessage[], appActive: boolean, alreadySent: ReadonlySet<string>): QuestionShown[] {
  if (!appActive) return [];
  return thread.flatMap((m) => (m.ask && !alreadySent.has(m.id) ? [{ approvalId: m.ask.approvalId, messageId: m.id }] : []));
}
