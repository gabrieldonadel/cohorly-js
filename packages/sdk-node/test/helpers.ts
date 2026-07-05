import { TransportError } from "../src/transport.js";
import type { CohorlyTransport } from "../src/types.js";

export interface SentRequest {
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Mock transport (no network). By default every request succeeds; pass
 * `respond` to decide status per call (1-based call number). Non-2xx
 * statuses throw TransportError like the real fetch transport; status 0
 * simulates a network failure (generic Error).
 */
export function createMockTransport(
  respond?: (n: number) => { status: number; retryAfterMs?: number },
) {
  const requests: SentRequest[] = [];
  const transport: CohorlyTransport = async (url, body, headers) => {
    requests.push({ url, path: new URL(url).pathname, body, headers });
    const { status, retryAfterMs } = respond?.(requests.length) ?? { status: 200 };
    if (status === 0) throw new Error("network down");
    if (status < 200 || status >= 300) {
      throw new TransportError(status, retryAfterMs);
    }
  };
  return { transport, requests };
}

export function trackBodies(requests: SentRequest[]): unknown[][] {
  return requests
    .filter((r) => r.path === "/track")
    .map((r) => r.body as unknown[]);
}
