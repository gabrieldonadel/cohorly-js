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

/**
 * The requests sent to `path`, in order. A test that calls identify() cannot
 * assume `requests[0]` is its own /track or /engage call: identify() also
 * fires a best-effort /alias post, so the caller has to say which path it
 * means.
 */
export function requestsTo(requests: FakeRequest[], path: string): FakeRequest[] {
  return requests.filter((r) => r.path === path);
}

/**
 * Feature-flag evaluation runs on init, so it would otherwise land in every
 * ingestion test's `requests` array (usually first, shifting `requests[0]`).
 * The ingestion helpers below therefore record only ingestion paths; the flag
 * behaviour has its own fetch fake in `flags.test.ts`.
 */
const FLAGS_PATH = "/flags/evaluate";

export function createFakeFetch(opts: { fail?: boolean } = {}) {
  const requests: FakeRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (path === FLAGS_PATH) {
      return new Response(JSON.stringify({ flags: {} }), { status: 200 });
    }
    requests.push({ path, body });
    if (opts.fail) {
      return new Response("error", { status: 500 });
    }
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

/**
 * Fake fetch whose status/headers are decided per call by `respond`, letting
 * tests exercise the retry contract (429/400/413 + Retry-After).
 */
export function createProgrammableFetch(
  respond: (n: number) => { status: number; retryAfter?: string },
) {
  const requests: FakeRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (path === FLAGS_PATH) {
      return new Response(JSON.stringify({ flags: {} }), { status: 200 });
    }
    requests.push({ path, body });
    const { status, retryAfter } = respond(requests.length);
    const headers: Record<string, string> = {};
    if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
    const payload = status >= 200 && status < 300 ? JSON.stringify({ status: 1 }) : "error";
    return new Response(payload, { status, headers });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}
