// Normalize handles so one person maps to one identity.
// Phone is E.164. Email is lowercase. Returns null when invalid.

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^0-9+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) {
    if (!/^\+[1-9][0-9]{6,14}$/.test(digits)) return null;
    return digits;
  }
  if (!/^[0-9]{7,15}$/.test(digits)) return null;
  return `+${digits}`;
}

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
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
