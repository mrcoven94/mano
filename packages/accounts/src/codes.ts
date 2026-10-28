// Phone sign-in codes, sent by Mano over its own text line.
// AuthKit does not do phone sign-in (docs: hosted MFA uses TOTP, not SMS;
// the standalone MFA API is US-only second factor), so Mano sends a 6-digit
// code itself. Codes are hashed, expire in 10 minutes, allow 5 attempts,
// at most 3 sends per phone per hour plus a global cap. Responses are the
// same whether or not the phone has an account.

import { codeHashDomain, keyedHash, randomCode6 } from "./crypto";
import { normalizePhone } from "./normalize";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_MAX_SENDS_PER_HOUR = 3;

export function codeMessage(code: string): string {
  return `Your Mano code is ${code}. It expires in 10 minutes.`;
}

interface CodeRow {
  phoneHash: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export interface CodeSendResult {
  ok: true;
  // Always true shape; callers return the same response for unknown phones.
  sent: boolean;
}

export class PhoneCodeService {
  private codes = new Map<string, CodeRow>();
  private sendsByPhone = new Map<string, number[]>();
  private globalSends: number[] = [];
  private pepper: string;
  private globalCapPerHour: number;
  private now: () => number;

  constructor(options: { pepper: string; globalCapPerHour?: number; now?: () => number }) {
    this.pepper = options.pepper;
    this.globalCapPerHour = options.globalCapPerHour ?? 500;
    this.now = options.now ?? Date.now;
  }

  private prune(list: number[], now: number): number[] {
    return list.filter((t) => t > now - 3600_000);
  }

  async requestCode(
    rawPhone: string,
    send: (e164: string, message: string) => Promise<void>,
    accountExists: boolean,
  ): Promise<CodeSendResult> {
    const now = this.now();
    const e164 = normalizePhone(rawPhone);
    // Same response for invalid, unknown, or rate limited phones. No enumeration.
    if (!e164) return { ok: true, sent: true };
    const phoneHash = await keyedHash(e164, this.pepper, "mano-phone-code-target:v1");
    const sends = this.prune(this.sendsByPhone.get(phoneHash) ?? [], now);
    this.globalSends = this.prune(this.globalSends, now);
    const overPhone = sends.length >= CODE_MAX_SENDS_PER_HOUR;
    const overGlobal = this.globalSends.length >= this.globalCapPerHour;
    if (overPhone || overGlobal) return { ok: true, sent: true };
    // Record the send attempt even for unknown phones so timing stays close.
    sends.push(now);
    this.sendsByPhone.set(phoneHash, sends);
    this.globalSends.push(now);
    if (!accountExists) return { ok: true, sent: true };
    const code = randomCode6();
    const codeHash = await keyedHash(code, this.pepper, codeHashDomain());
    this.codes.set(phoneHash, { phoneHash, codeHash, expiresAt: now + CODE_TTL_MS, attempts: 0, createdAt: now });
    await send(e164, codeMessage(code));
    return { ok: true, sent: true };
  }

  // Test and stand-in hook: request a code for a known phone and return it.
  // Production never calls this; the code only leaves through the send callback.
  async requestCodeForTest(rawPhone: string): Promise<{ code: string } | null> {
    const e164 = normalizePhone(rawPhone);
    if (!e164) return null;
    const now = this.now();
    const phoneHash = await keyedHash(e164, this.pepper, "mano-phone-code-target:v1");
    const sends = this.prune(this.sendsByPhone.get(phoneHash) ?? [], now);
    if (sends.length >= CODE_MAX_SENDS_PER_HOUR) return null;
    sends.push(now);
    this.sendsByPhone.set(phoneHash, sends);
    const code = randomCode6();
    this.codes.set(phoneHash, {
      phoneHash,
      codeHash: await keyedHash(code, this.pepper, codeHashDomain()),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      createdAt: now,
    });
    return { code };
  }

  async verifyCode(rawPhone: string, code: string): Promise<boolean> {
    const e164 = normalizePhone(rawPhone);
    if (!e164) return false;
    const clean = code.trim();
    if (!/^[0-9]{6}$/.test(clean)) return false;
    const now = this.now();
    const phoneHash = await keyedHash(e164, this.pepper, "mano-phone-code-target:v1");
    const row = this.codes.get(phoneHash);
    if (!row) return false;
    if (row.expiresAt <= now) {
      this.codes.delete(phoneHash);
      return false;
    }
    if (row.attempts >= CODE_MAX_ATTEMPTS) {
      this.codes.delete(phoneHash);
      return false;
    }
    row.attempts += 1;
    const attemptHash = await keyedHash(clean, this.pepper, codeHashDomain());
    if (attemptHash !== row.codeHash) {
      if (row.attempts >= CODE_MAX_ATTEMPTS) this.codes.delete(phoneHash);
      return false;
    }
    this.codes.delete(phoneHash);
    return true;
  }

}
