// One unsent chat draft handed from one screen to the chat, in memory
// only. "Ask Mano to change something" quotes the approval into it; the
// chat takes it once on focus and the person edits and sends it. It
// never rides in a URL, where a web build would keep it in history, and
// it is bound to the session token, so a later sign-in never sees it.

let held: { token: string; text: string } | null = null;

export function holdChatDraft(token: string, text: string): void {
  held = { token, text };
}

// The draft for this session, once. A draft from another session is
// dropped, not returned.
export function takeChatDraft(token: string): string | null {
  const draft = held;
  held = null;
  return draft && draft.token === token ? draft.text : null;
}

// The words the chat opens with: the approval quoted by its purpose,
// then the start of the person's own request.
export function changeDraft(about: string, purpose: string, ask: string): string {
  return `${about} "${purpose}": ${ask} `;
}
