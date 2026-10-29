// Per-person AES-256-GCM ciphers over expo-crypto. Each resident gets a
// random data key stored in secure storage under a name derived from
// their ID; sign-out deletes it, which cryptographically wipes every
// payload it sealed. Refuses to run where secure storage is missing.

import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import { b64encode, utf8ToBytes } from "./base64";
import type { Cipher, CipherFactory } from "./cipher";
import { assertSafeKey, type SecureBackend } from "./kv";

function keyName(personId: string): string {
  const encoded = b64encode(utf8ToBytes(personId)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const name = `mano.dkey.${encoded}`;
  assertSafeKey(name);
  return name;
}

export class ExpoCipherFactory implements CipherFactory {
  private backend: SecureBackend;
  constructor(backend: SecureBackend) {
    this.backend = backend;
  }

  async forPerson(personId: string): Promise<Cipher> {
    if (!(await this.backend.isAvailable())) throw new Error("Secure storage is unavailable.");
    const name = keyName(personId);
    let raw = await this.backend.get(name);
    if (!raw) {
      const fresh = await AESEncryptionKey.generate();
      raw = await fresh.encoded("base64");
      await this.backend.set(name, raw);
    }
    const key = await AESEncryptionKey.import(raw, "base64");
    return {
      encrypt: async (plaintext: Uint8Array) => {
        const sealed = await aesEncryptAsync(plaintext, key);
        const [iv, data] = await Promise.all([sealed.iv(), sealed.ciphertext({ includeTag: true })]);
        return { iv, data };
      },
      decrypt: async (iv: Uint8Array, data: Uint8Array) =>
        aesDecryptAsync(AESSealedData.fromParts(iv, data, 16), key),
    };
  }

  async forgetPerson(personId: string): Promise<void> {
    if (!(await this.backend.isAvailable())) return;
    await this.backend.remove(keyName(personId));
  }
}
