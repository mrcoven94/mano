// Encrypted key-value storage for resident payloads. Values are sealed
// with AES-256-GCM under a per-person key; the envelope carries a
// version so future formats fail loudly instead of misreading.
//
// This file never touches Expo or node modules: the app injects an
// expo-crypto cipher, tests inject a node:crypto one.

import { b64decode, b64encode, bytesToUtf8, utf8ToBytes } from "./base64";
import type { KeyValue } from "./kv";

export class DecryptError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Could not decrypt stored value for ${key}.`);
    this.name = "DecryptError";
    this.key = key;
  }
}

export interface Cipher {
  encrypt(plaintext: Uint8Array): Promise<{ iv: Uint8Array; data: Uint8Array }>;
  decrypt(iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}

export interface CipherFactory {
  forPerson(personId: string): Promise<Cipher>;
  forgetPerson(personId: string): Promise<void>;
}

interface Envelope {
  v: number;
  iv: string;
  data: string;
}

function parseEnvelope(raw: string): Envelope {
  const parsed = JSON.parse(raw) as Partial<Envelope>;
  if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.data !== "string") {
    throw new Error("Unknown envelope.");
  }
  return { v: 1, iv: parsed.iv, data: parsed.data };
}

export class EncryptedStore implements KeyValue {
  private inner: KeyValue;
  private factory: CipherFactory;
  private personId: string;

  constructor(inner: KeyValue, factory: CipherFactory, personId: string) {
    this.inner = inner;
    this.factory = factory;
    this.personId = personId;
  }

  async get(key: string): Promise<string | null> {
    const raw = await this.inner.get(key);
    if (raw == null) return null;
    let env: Envelope;
    try {
      env = parseEnvelope(raw);
    } catch {
      throw new DecryptError(key);
    }
    try {
      const cipher = await this.factory.forPerson(this.personId);
      const plain = await cipher.decrypt(b64decode(env.iv), b64decode(env.data));
      return bytesToUtf8(plain);
    } catch (err) {
      if (err instanceof DecryptError) throw err;
      throw new DecryptError(key);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const cipher = await this.factory.forPerson(this.personId);
    const { iv, data } = await cipher.encrypt(utf8ToBytes(value));
    const env: Envelope = { v: 1, iv: b64encode(iv), data: b64encode(data) };
    await this.inner.set(key, JSON.stringify(env));
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key);
  }
}
