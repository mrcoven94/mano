// The person's own Mano email address. Channels mints it and sends it in
// the signed turn body; only the person it belongs to is ever in that turn.
const ADDRESS = /^[a-z0-9+._-]{1,64}@[a-z0-9.-]{1,253}$/;

export function parseEmailAddress(value: unknown): string | null {
  return typeof value === "string" && ADDRESS.test(value) ? value : null;
}

export function emailAddressLine(address: string): string {
  return (
    `The person's own Mano email address is ${address}. It is private to them, and what offices send there comes to you as a letter. ` +
    "Give it exactly as written when they ask for it or an office needs one, and otherwise do not bring it up."
  );
}
