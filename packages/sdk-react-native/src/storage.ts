import type { AsyncStorageLike } from "./types.js";

/** Zero-dependency in-memory fallback used when no storage is injected.
 * Data does not survive app relaunch, but keeps the package fully standalone. */
export class InMemoryStorage implements AsyncStorageLike {
  private store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}
