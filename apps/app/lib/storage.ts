// Platform storage singletons. Resident payloads are encrypted per
// person (see cipher.ts); only the language override stays plain.
// The session token lives in the secure store on native and in a
// Secure SameSite cookie on web, the seam the site will promote to an
// httpOnly cookie once the engine accepts cookie auth; localStorage
// never holds a session.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  CookieStore,
  SecureTokenStore,
  STORE_PREFIX,
  assertSafeKey,
  type KeyValue,
  type SecureBackend,
} from "./kv";

export type { KeyValue, SecureBackend } from "./kv";

class WebStore implements KeyValue {
  async get(key: string): Promise<string | null> {
    assertSafeKey(key);
    try {
      return window.localStorage.getItem(`${STORE_PREFIX}${key}`);
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    try {
      window.localStorage.setItem(`${STORE_PREFIX}${key}`, value);
    } catch {
      // Private browsing: the app still works for the session.
    }
  }
  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      window.localStorage.removeItem(`${STORE_PREFIX}${key}`);
    } catch {
      // Nothing stored, nothing to remove.
    }
  }
}

class AsyncStore implements KeyValue {
  async get(key: string): Promise<string | null> {
    assertSafeKey(key);
    return AsyncStorage.getItem(`${STORE_PREFIX}${key}`);
  }
  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    await AsyncStorage.setItem(`${STORE_PREFIX}${key}`, value);
  }
  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    await AsyncStorage.removeItem(`${STORE_PREFIX}${key}`);
  }
}

export const expoSecureBackend: SecureBackend = {
  async isAvailable(): Promise<boolean> {
    return SecureStore.isAvailableAsync();
  },
  async get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  },
};

export const appStore: KeyValue = Platform.OS === "web" ? new WebStore() : new AsyncStore();
export const tokenStore: KeyValue = Platform.OS === "web" ? new CookieStore() : new SecureTokenStore(expoSecureBackend);

// One-way scrub of pre-release keys: the colon form SecureStore rejects
// and the plaintext outbox. Best-effort and idempotent; runs at launch.
export async function scrubLegacyKeys(): Promise<void> {
  if (Platform.OS === "web") {
    try {
      window.localStorage.removeItem("mano:session");
      window.localStorage.removeItem("mano:outbox:v1");
    } catch {
      // Nothing to scrub.
    }
    return;
  }
  try {
    await AsyncStorage.removeItem("mano:outbox:v1");
  } catch {
    // Already gone.
  }
  try {
    await SecureStore.deleteItemAsync("mano:session");
  } catch {
    // Already gone.
  }
}
