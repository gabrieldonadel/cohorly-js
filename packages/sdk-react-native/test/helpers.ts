import type { AsyncStorageLike } from "../src/types.js";

export class FakeStorage implements AsyncStorageLike {
  store = new Map<string, string>();

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

export interface FakeRequest {
  path: string;
  body: unknown;
}

export function createFakeFetch(opts: { fail?: boolean } = {}) {
  const requests: FakeRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ path, body });
    if (opts.fail) {
      return new Response("error", { status: 500 });
    }
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}
