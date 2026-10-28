// Small storage adapters. The session token lives in the secure store
// on native and localStorage on web; the offline queue and caches use
// AsyncStorage on native and localStorage on web. Tests use memory.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryStore implements KeyValue {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class WebStore implements KeyValue {
  async get(key: string): Promise<string | null> {
    try {
      return window.localStorage.getItem(`mano:${key}`);
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    try {
      window.localStorage.setItem(`mano:${key}`, value);
    } catch {
      // Private browsing: the app still works for the session.
    }
  }
  async remove(key: string): Promise<void> {
    try {
      window.localStorage.removeItem(`mano:${key}`);
    } catch {
      // Nothing stored, nothing to remove.
    }
  }
}

class AsyncStore implements KeyValue {
  async get(key: string): Promise<string | null> {
    return AsyncStorage.getItem(`mano:${key}`);
  }
  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(`mano:${key}`, value);
  }
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(`mano:${key}`);
  }
}

class SecureTokenStore implements KeyValue {
  async get(key: string): Promise<string | null> {
    if (!(await SecureStore.isAvailableAsync())) return null;
    return SecureStore.getItemAsync(`mano:${key}`);
  }
  async set(key: string, value: string): Promise<void> {
    if (!(await SecureStore.isAvailableAsync())) return;
    await SecureStore.setItemAsync(`mano:${key}`, value);
  }
  async remove(key: string): Promise<void> {
    if (!(await SecureStore.isAvailableAsync())) return;
    await SecureStore.deleteItemAsync(`mano:${key}`);
  }
}

export const appStore: KeyValue = Platform.OS === "web" ? new WebStore() : new AsyncStore();
export const tokenStore: KeyValue = Platform.OS === "web" ? new WebStore() : new SecureTokenStore();
