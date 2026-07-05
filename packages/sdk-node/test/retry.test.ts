import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohorlyNode } from "../src/index.js";
import { createMockTransport, trackBodies } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retry contract", () => {
  it("500: keeps the queue and backs off exponentially (2s base, doubling)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0
    const { transport, requests } = createMockTransport((n) => ({
      status: n <= 3 ? 500 : 200,
    }));
    const client = new CohorlyNode("tok", { flushIntervalMs: 1000, transport });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // t=1000: attempt 1 fails
    expect(requests).toHaveLength(1);
    expect(client.queueSize).toBe(1); // queue kept

    await vi.advanceTimersByTimeAsync(1000); // t=2000: within 2000ms backoff
    expect(requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000); // t=3000: attempt 2 fails
    expect(requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3000); // t=6000: within 4000ms backoff
    expect(requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000); // t=7000: attempt 3 fails
    expect(requests).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(7000); // t=14000: within 8000ms backoff
    expect(requests).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1000); // t=15000: attempt 4 succeeds
    expect(requests).toHaveLength(4);
    expect(client.queueSize).toBe(0);
    await client.shutdown();
  });

  it("network error: treated as retriable with backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { transport, requests } = createMockTransport((n) => ({
      status: n === 1 ? 0 : 200, // status 0 = thrown network error
    }));
    const client = new CohorlyNode("tok", { flushIntervalMs: 1000, transport });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // fails
    expect(client.queueSize).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // t=2000: still backing off
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // t=3000: retry succeeds
    expect(requests).toHaveLength(2);
    expect(client.queueSize).toBe(0);
    await client.shutdown();
  });

  it("429: honors Retry-After over the computed delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { transport, requests } = createMockTransport((n) =>
      n === 1 ? { status: 429, retryAfterMs: 7000 } : { status: 200 },
    );
    const client = new CohorlyNode("tok", { flushIntervalMs: 1000, transport });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // t=1000: attempt 1 -> 429
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000); // t=7000: inside Retry-After window
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // t=8000: retried
    expect(requests).toHaveLength(2);
    await client.shutdown();
  });

  it("429: Retry-After is capped at maxRetryDelayMs", async () => {
    const { transport, requests } = createMockTransport((n) =>
      n === 1 ? { status: 429, retryAfterMs: 60_000 } : { status: 200 },
    );
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 1000,
      maxRetryDelayMs: 5000,
      transport,
    });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // t=1000: 429 with huge Retry-After
    await vi.advanceTimersByTimeAsync(4000); // t=5000: still within capped 5000
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // t=6000: retried at the cap
    expect(requests).toHaveLength(2);
    await client.shutdown();
  });

  it("backoff delay is capped at maxRetryDelayMs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { transport, requests } = createMockTransport((n) => ({
      status: n <= 3 ? 500 : 200,
    }));
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 1000,
      maxRetryDelayMs: 3000, // exp would be 2000, 4000 -> capped 3000
      transport,
    });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // t=1000: fail 1 (delay 2000)
    await vi.advanceTimersByTimeAsync(2000); // t=3000: fail 2 (delay capped 3000)
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000); // t=5000: within cap window
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000); // t=6000: fail 3
    expect(requests).toHaveLength(3);
    await client.shutdown();
  });

  it("applies +/-20% jitter to the computed backoff", async () => {
    // Math.random() = 0 -> jitter -20% -> delay 1600ms after first failure.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { transport, requests } = createMockTransport((n) => ({
      status: n === 1 ? 500 : 200,
    }));
    const client = new CohorlyNode("tok", { flushIntervalMs: 100, transport });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(100); // t=100: fail, backoff until 1700
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500); // t=1600: still waiting
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100); // t=1700: retried
    expect(requests).toHaveLength(2);
    await client.shutdown();

    // Math.random() = 1 -> jitter +20% -> delay 2400ms.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const second = createMockTransport((n) => ({
      status: n === 1 ? 500 : 200,
    }));
    const client2 = new CohorlyNode("tok", {
      flushIntervalMs: 100,
      transport: second.transport,
    });
    await client2.track("e", { distinct_id: "u" });
    await vi.advanceTimersByTimeAsync(100); // fail, backoff for 2400ms
    expect(second.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2300); // just inside the window
    expect(second.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100); // window elapsed: retried
    expect(second.requests).toHaveLength(2);
    await client2.shutdown();
  });

  it("413: halves the effective batch size down to a floor of 1", async () => {
    let accept = false;
    const { transport, requests } = createMockTransport(() => ({
      status: accept ? 200 : 413,
    }));
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 0,
      batchSize: 8,
      transport,
    });

    const events = Array.from({ length: 8 }, (_, i) => ({
      event: "e",
      properties: { distinct_id: `u${i}` },
    }));
    await client.trackBatch(events); // size trigger: 8 -> 413 -> 4 -> 2 -> 1
    await vi.waitFor(() =>
      expect(trackBodies(requests).map((b) => b.length)).toEqual([8, 4, 2, 1]),
    );
    expect(client.queueSize).toBe(8); // nothing dropped

    accept = true;
    requests.length = 0;
    await client.flush(); // drains one event per request at the floor
    expect(trackBodies(requests).map((b) => b.length)).toEqual(
      Array.from({ length: 8 }, () => 1),
    );
    expect(client.queueSize).toBe(0);
  });

  it("400: drops the rejected batch and keeps draining", async () => {
    const { transport, requests } = createMockTransport((n) => ({
      status: n === 1 ? 400 : 200,
    }));
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 0,
      batchSize: 2,
      transport,
    });

    await client.trackBatch([
      { event: "bad-0", properties: { distinct_id: "u" } },
      { event: "bad-1", properties: { distinct_id: "u" } },
      { event: "good-0", properties: { distinct_id: "u" } },
      { event: "good-1", properties: { distinct_id: "u" } },
    ]);
    await client.flush();

    const bodies = trackBodies(requests) as { event: string }[][];
    expect(bodies).toHaveLength(2);
    expect(bodies[0].map((e) => e.event)).toEqual(["bad-0", "bad-1"]); // rejected + dropped
    expect(bodies[1].map((e) => e.event)).toEqual(["good-0", "good-1"]);
    expect(client.queueSize).toBe(0);
  });

  it("401: keeps the queue and backs off at the max delay", async () => {
    const { transport, requests } = createMockTransport((n) => ({
      status: n === 1 ? 401 : 200,
    }));
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 1000,
      maxRetryDelayMs: 10_000,
      transport,
    });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // t=1000: 401
    expect(requests).toHaveLength(1);
    expect(client.queueSize).toBe(1); // queue kept

    await vi.advanceTimersByTimeAsync(9000); // t=10000: still in max backoff
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // t=11000: retried
    expect(requests).toHaveLength(2);
    expect(client.queueSize).toBe(0);
    await client.shutdown();
  });

  it("forced flush runs even while backing off and rejects on failure", async () => {
    const { transport, requests } = createMockTransport(() => ({ status: 500 }));
    const client = new CohorlyNode("tok", { flushIntervalMs: 1000, transport });
    await client.track("e", { distinct_id: "u" });

    await vi.advanceTimersByTimeAsync(1000); // enter backoff
    expect(requests).toHaveLength(1);

    await expect(client.flush()).rejects.toThrow(); // forced: tries anyway
    expect(requests).toHaveLength(2);
    expect(client.queueSize).toBe(1);
    await client.shutdown();
  });
});
