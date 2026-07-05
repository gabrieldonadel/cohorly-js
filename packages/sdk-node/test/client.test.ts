import { afterEach, describe, expect, it, vi } from "vitest";
import Cohorly, { CohorlyNode, LIB_VERSION, init } from "../src/index.js";
import type { TrackEvent } from "../src/types.js";
import { createMockTransport, trackBodies } from "./helpers.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("init", () => {
  it("factory and default export create a CohorlyNode", () => {
    const a = init("tok", { flushIntervalMs: 0 });
    const b = Cohorly.init("tok", { flushIntervalMs: 0 });
    expect(a).toBeInstanceOf(CohorlyNode);
    expect(b).toBeInstanceOf(CohorlyNode);
  });

  it("requires a token", () => {
    expect(() => new CohorlyNode("")).toThrow(TypeError);
  });
});

describe("default properties", () => {
  it("stamps distinct_id, time, $insert_id, $lib, $lib_version", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok-1", { flushIntervalMs: 0, transport });

    await client.track("signup", { distinct_id: "user-1", plan: "premium" });
    await client.flush();

    const [batch] = trackBodies(requests);
    expect(batch).toHaveLength(1);
    const evt = batch[0] as TrackEvent;
    expect(evt.event).toBe("signup");
    expect(evt.properties.distinct_id).toBe("user-1");
    expect(evt.properties.time).toBe(1_700_000_000_000);
    expect(evt.properties.$insert_id).toMatch(UUID_RE);
    expect(evt.properties.$lib).toBe("node");
    expect(evt.properties.$lib_version).toBe(LIB_VERSION);
    expect(evt.properties.plan).toBe("premium");
    // token travels as a header, not in the body
    expect(evt.properties.token).toBeUndefined();
    expect(requests[0].headers["X-Cohorly-Token"]).toBe("tok-1");
  });

  it("caller-supplied time and $insert_id win", async () => {
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });

    await client.track("e", {
      distinct_id: "u",
      time: 123,
      $insert_id: "fixed-id",
    });
    await client.flush();

    const evt = (trackBodies(requests)[0] as TrackEvent[])[0];
    expect(evt.properties.time).toBe(123);
    expect(evt.properties.$insert_id).toBe("fixed-id");
  });

  it("import stamps the explicit timestamp (Date or unix ms)", async () => {
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });

    await client.import("old-1", new Date(1000), { distinct_id: "u" });
    await client.import("old-2", 2000, { distinct_id: "u" });
    await client.flush();

    const [batch] = trackBodies(requests) as TrackEvent[][];
    expect(batch.map((e) => e.properties.time)).toEqual([1000, 2000]);
  });

  it("rejects without distinct_id (promise and callback styles)", async () => {
    const { transport } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });

    await expect(
      client.track("e", {} as never),
    ).rejects.toThrow(/distinct_id is required/);

    const err = await new Promise<Error | undefined>((resolve) => {
      void client.track("e", {} as never, resolve).catch(() => {});
    });
    expect(err).toBeInstanceOf(TypeError);
  });

  it("rejects without an event name", async () => {
    const { transport } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });
    await expect(
      client.track("", { distinct_id: "u" }),
    ).rejects.toThrow(/event name is required/);
  });
});

describe("batching", () => {
  it("flushes when the queue reaches batchSize", async () => {
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 0,
      batchSize: 3,
      transport,
    });

    await client.track("a", { distinct_id: "u" });
    await client.track("b", { distinct_id: "u" });
    expect(requests).toHaveLength(0); // below threshold, nothing sent

    await client.track("c", { distinct_id: "u" });
    await vi.waitFor(() => expect(trackBodies(requests)).toHaveLength(1));
    expect(trackBodies(requests)[0]).toHaveLength(3);
    expect(client.queueSize).toBe(0);
  });

  it("auto-flushes on the interval timer", async () => {
    vi.useFakeTimers();
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 5000, transport });

    await client.track("a", { distinct_id: "u" });
    expect(requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(trackBodies(requests)).toHaveLength(1);
    await client.shutdown();
  });

  it("clamps batchSize to the 500-event server cap and drains in chunks", async () => {
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", {
      flushIntervalMs: 0,
      batchSize: 2000, // above the server cap
      transport,
    });

    const events = Array.from({ length: 600 }, (_, i) => ({
      event: "bulk",
      properties: { distinct_id: `u${i}` },
    }));
    await client.trackBatch(events);
    await client.flush();

    const sizes = trackBodies(requests).map((b) => b.length);
    expect(sizes).toEqual([500, 100]);
    expect(client.queueSize).toBe(0);
  });

  it("track_batch/import_batch aliases work", async () => {
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });

    await client.track_batch([
      { event: "x", properties: { distinct_id: "u" } },
    ]);
    await client.import_batch([
      { event: "y", properties: { distinct_id: "u", time: 42 } },
    ]);
    await client.flush();

    const [batch] = trackBodies(requests) as TrackEvent[][];
    expect(batch.map((e) => e.event)).toEqual(["x", "y"]);
    expect(batch[1].properties.time).toBe(42);
  });

  it("caps the queue at maxQueueSize, dropping the oldest events", async () => {
    let fail = true;
    const { transport, requests } = createMockTransport(() => ({
      status: fail ? 500 : 200,
    }));
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });

    const events = Array.from({ length: 1100 }, (_, i) => ({
      event: "e",
      properties: { distinct_id: `u${i}` },
    }));
    await client.trackBatch(events); // size-trigger flush fails with 500
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(client.queueSize).toBe(1000); // oldest 100 dropped

    fail = false;
    requests.length = 0;
    await client.flush();
    const bodies = trackBodies(requests) as TrackEvent[][];
    expect(bodies.reduce((n, b) => n + b.length, 0)).toBe(1000);
    expect(bodies[0][0].properties.distinct_id).toBe("u100");
  });

  it("supports the callback style for track and flush", async () => {
    const { transport } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });

    const trackErr = await new Promise<Error | undefined>((resolve) => {
      void client.track("e", { distinct_id: "u" }, resolve);
    });
    expect(trackErr).toBeUndefined();

    const flushErr = await new Promise<Error | undefined>((resolve) => {
      void client.flush(resolve);
    });
    expect(flushErr).toBeUndefined();
  });
});

describe("shutdown", () => {
  it("flushes pending events and stops the timer", async () => {
    vi.useFakeTimers();
    const { transport, requests } = createMockTransport();
    const client = new CohorlyNode("tok", { flushIntervalMs: 5000, transport });

    await client.track("pending", { distinct_id: "u" });
    await client.shutdown();
    expect(trackBodies(requests)).toHaveLength(1);

    // Timer no longer fires after shutdown.
    await client.track("late", { distinct_id: "u" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(trackBodies(requests)).toHaveLength(1);
  });

  it("never rejects, even when the final flush fails", async () => {
    const { transport } = createMockTransport(() => ({ status: 500 }));
    const client = new CohorlyNode("tok", { flushIntervalMs: 0, transport });
    await client.track("e", { distinct_id: "u" });
    await expect(client.shutdown()).resolves.toBeUndefined();
  });
});
