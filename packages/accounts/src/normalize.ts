// Normalize handles so one person maps to one identity.
// Phone is E.164. Email is lowercase. Returns null when invalid.

const NON_PHONE_CHARS_RE = /[^0-9+]/g;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const BARE_PHONE_DIGITS_RE = /^[0-9]{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NON_DIGIT_RE = /\D/g;

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(NON_PHONE_CHARS_RE, "");
  if (!digits) return null;
  if (digits.startsWith("+")) {
    if (!E164_RE.test(digits)) return null;
    return digits;
  }
  if (!BARE_PHONE_DIGITS_RE.test(digits)) return null;
  return `+${digits}`;
}

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

export function maskPhone(e164: string): string {
  const digits = e164.replace(NON_DIGIT_RE, "");
  const last2 = digits.slice(-2);
  return `(+..) ...-${last2}`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return "***@***";
  const domain = email.slice(at + 1);
  return `${email[0]}***@${domain}`;
}

export function maskWorkosUserId(id: string): string {
  if (id.length <= 8) return "workos:***";
  return `workos:...${id.slice(-4)}`;
}
