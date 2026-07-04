import type { CohorlyStorage } from "@cohorly/core";

// In-memory fallback used during SSR (no window) or if localStorage throws
// (privacy mode / quota exceeded).
const memory = new Map<string, string>();

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export const localStorageAdapter: CohorlyStorage = {
  get(key) {
    if (!hasLocalStorage()) return memory.get(key) ?? null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    if (!hasLocalStorage()) {
      memory.set(key, value);
      return;
    }
    try {
      window.localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  remove(key) {
    if (!hasLocalStorage()) {
      memory.delete(key);
      return;
    }
    try {
      window.localStorage.removeItem(key);
    } catch {
      memory.delete(key);
    }
  },
};
