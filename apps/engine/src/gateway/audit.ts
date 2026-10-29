import { sha256Hex } from "../hash.js";

declare const audited: unique symbol;

// A SHA-256 digest made for the audit log, the only computed string an
// audit entry accepts.
export type AuditDigest = string & { readonly [audited]: true };

type AuditField<V> = V extends AuditDigest | number | boolean | null | undefined
  ? V
  : V extends string
    ? string extends V
      ? never
      : V
    : never;

// One audit_log entry. Every field is a code literal (or a union of
// literals, such as an action type or a status), a number, a boolean or
// an AuditDigest. A plain string could carry caller text (a URL, a key,
// an ID, an error message), so it does not type-check until it goes
// through auditDigest. Use as `entry: T & AuditEntry<T>` with a const T.
export type AuditEntry<T> = { [K in keyof T]: AuditField<T[K]> };

export async function auditDigest(text: string): Promise<AuditDigest> {
  return (await sha256Hex(text)) as AuditDigest;
}
