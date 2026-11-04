// The address and challenge between the two sign-in screens. They stay in
// memory, not in route params, so an email address never lands in a URL,
// browser history or a server log. A reload starts sign-in over.

export interface PendingSignIn {
  email: string;
  challengeId: string;
}

let pending: PendingSignIn | null = null;

export function setPendingSignIn(next: PendingSignIn | null): void {
  pending = next;
}

export function pendingSignIn(): PendingSignIn | null {
  return pending;
}
