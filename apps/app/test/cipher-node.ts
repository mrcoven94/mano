// Node AES-GCM cipher for tests. The app uses expo-crypto through the
// same Cipher interface; this file never ships in the bundle.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Cipher } from "../lib/cipher";

export function nodeCipher(key: Uint8Array): Cipher {
  if (key.length !== 32) throw new Error("Test key must be 32 bytes.");
  return {
    async encrypt(plaintext: Uint8Array): Promise<{ iv: Uint8Array; data: Uint8Array }> {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return { iv: new Uint8Array(iv), data: new Uint8Array(enc) };
    },
    async decrypt(iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
      const tag = data.slice(data.length - 16);
      const body = data.slice(0, data.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    },
  };
}
