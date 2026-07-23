import { afterEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "./client.js";
import { TransportError } from "./transport.js";
import type { CohorlyStorage, CohorlyTransport } from "./types.js";

function makeStorage(): CohorlyStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => (map.has(key) ? map.get(key)! : null),
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

function makeClient(overrides?: {
  storage?: CohorlyStorage;
  transport?: CohorlyTransport;
}) {
  const storage = overrides?.storage ?? makeStorage();
  const calls: { url: string; body: unknown }[] = [];
  const transport: CohorlyTransport =
    overrides?.transport ??
    (async (url, body) => {
      calls.push({ url, body });
    });
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    storage,
    transport,
    flushIntervalMs: 0, // disable auto-flush timer in tests
    batchSize: 20,
  });
  return { client, storage, calls };
}

describe("track", () => {
  it("enqueues an event with the expected shape", () => {
    const { client } = makeClient();
    const evt = client.track("Signed Up", { plan: "pro" });

    expect(evt.event).toBe("Signed Up");
    expect(evt.properties.plan).toBe("pro");
    expect(typeof evt.properties.distinct_id).toBe("string");
    expect(evt.properties.distinct_id.length).toBeGreaterThan(0);
    expect(typeof evt.properties.time).toBe("number");
    expect(typeof evt.properties.$insert_id).toBe("string");
    expect(evt.properties.$insert_id).toMatch(
      /^[0-9a-f-]{36}$|^[0-9a-f]{32}$/i,
    );
    expect(evt.properties.$lib).toBe("core");
  });

  it("merges registered super properties into every event", () => {
    const { client } = makeClient();
    client.register({ app_version: "1.2.3" });
    const evt = client.track("Viewed Page");
    expect(evt.properties.app_version).toBe("1.2.3");

    client.unregister("app_version");
    const evt2 = client.track("Viewed Page 2");
    expect(evt2.properties.app_version).toBeUndefined();
  });

  it("event-level properties override super properties", () => {
    const { client } = makeClient();
    client.register({ plan: "free" });
    const evt = client.track("Upgraded", { plan: "pro" });
    expect(evt.properties.plan).toBe("pro");
  });
});

describe("identify", () => {
  it("sends an alias request when switching from an anonymous id, then persists the new id", async () => {
    const { client, calls, storage } = makeClient();
    const anonId = client.getDistinctId();
    expect(client.isAnonymous()).toBe(true);

    await client.identify("user-42");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:4000/alias");
    expect(calls[0].body).toEqual({ alias: anonId, distinct_id: "user-42" });

    expect(client.getDistinctId()).toBe("user-42");
    expect(client.isAnonymous()).toBe(false);
    expect(storage.get("cohorly_distinct_id")).toBe("user-42");
    expect(storage.get("cohorly_anonymous")).toBe("0");
  });

  it("does not alias again once already identified", async () => {
    const { client, calls } = makeClient();
    await client.identify("user-42");
    await client.identify("user-99");
    // second identify: no longer anonymous, so no new alias call
    expect(calls).toHaveLength(1);
    expect(client.getDistinctId()).toBe("user-99");
  });
});

describe("reset", () => {
  it("generates a fresh anonymous id", () => {
    const { client } = makeClient();
    const before = client.getDistinctId();
    client.reset();
    expect(client.getDistinctId()).not.toBe(before);
    expect(client.isAnonymous()).toBe(true);
  });
});

describe("batching and flush", () => {
  it("auto-flushes once batchSize is reached", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const storage = makeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport: async (url, body) => {
        calls.push({ url, body });
      },
      flushIntervalMs: 0,
      batchSize: 2,
    });

    client.track("a");
    client.track("b");
    // batchSize reached synchronously triggers an async flush; wait a tick
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("http://localhost:4000/track");
    expect(Array.isArray(calls[0].body)).toBe(true);
    expect((calls[0].body as unknown[]).length).toBe(2);
  });

  it("flush() sends the queued batch to /track", async () => {
    const { client, calls } = makeClient();
    client.track("a");
    client.track("b");
    await client.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:4000/track");
    expect((calls[0].body as unknown[]).length).toBe(2);
  });

  it("persists the queue across client instances via storage", () => {
    const storage = makeStorage();
    const { client: client1 } = makeClient({ storage });
    client1.track("a");

    const { client: client2 } = makeClient({ storage });
    // second client loads persisted queue from storage
    const raw = storage.get("cohorly_queue");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toHaveLength(1);
    void client2;
  });

  it("keeps events in the queue when the transport rejects", async () => {
    const storage = makeStorage();
    const failingTransport: CohorlyTransport = async () => {
      throw new Error("network down");
    };
    const { client } = makeClient({ storage, transport: failingTransport });
    client.track("a");
    await client.flush();

    const raw = storage.get("cohorly_queue");
    expect(JSON.parse(raw!)).toHaveLength(1);
  });
});

describe("token", () => {
  function makeTokenClient(overrides?: { storage?: CohorlyStorage; transport?: CohorlyTransport }) {
    const storage = overrides?.storage ?? makeStorage();
    const calls: { url: string; body: unknown }[] = [];
    const transport: CohorlyTransport =
      overrides?.transport ??
      (async (url, body) => {
        calls.push({ url, body });
      });
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 20,
      token: "proj_abc123",
    });
    return { client, storage, calls };
  }

  it("stamps token onto every tracked event's properties", () => {
    const { client } = makeTokenClient();
    const evt = client.track("Signed Up", { plan: "pro" });
    expect(evt.properties.token).toBe("proj_abc123");
  });

  it("includes token in /engage bodies", async () => {
    const { client, calls } = makeTokenClient();
    await client.people.set({ name: "Ada" });
    const engageCall = calls.find((c) => c.url.endsWith("/engage"));
    expect(engageCall!.body).toMatchObject({ token: "proj_abc123" });
  });

  it("includes token in /alias bodies", async () => {
    const { client, calls } = makeTokenClient();
    await client.identify("user-1");
    const aliasCall = calls.find((c) => c.url.endsWith("/alias"));
    expect(aliasCall!.body).toMatchObject({ token: "proj_abc123" });
  });

  it("omits token entirely when not configured", () => {
    const { client } = makeClient();
    const evt = client.track("No Token Event");
    expect("token" in evt.properties).toBe(false);
  });
});

describe("retry contract", () => {
  const apiHost = "http://localhost:4000";

  // Let a fire-and-forget maybeFlush() settle its microtasks.
  const tick = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  function queueLen(storage: CohorlyStorage): number {
    const raw = storage.get("cohorly_queue");
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("429 keeps the queue intact and does not drop events", async () => {
    const storage = makeStorage();
    const calls: unknown[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      throw new TransportError(429, 60_000);
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 20,
    });
    client.track("a");
    client.track("b");
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(queueLen(storage)).toBe(2);
    client.stop();
  });

  it("respects Retry-After: retryAfter=0 allows immediate auto-retry, a large value blocks it", async () => {
    // retryAfter overrides the computed 2000ms backoff, so a 0 lets the next
    // size-triggered auto-flush proceed while a large value blocks it.
    async function run(retryAfterMs: number): Promise<number> {
      const storage = makeStorage();
      const calls: unknown[] = [];
      const transport: CohorlyTransport = async (_url, body) => {
        calls.push(body);
        throw new TransportError(429, retryAfterMs);
      };
      const client = new CohorlyClient({
        apiHost,
        storage,
        transport,
        flushIntervalMs: 0,
        batchSize: 1,
      });
      client.track("a"); // size trigger -> attempt 1 (fails, sets backoff)
      await tick();
      client.track("b"); // size trigger -> maybeFlush, honored/blocked by backoff
      await tick();
      client.stop();
      return calls.length;
    }

    expect(await run(0)).toBe(2); // backoff elapsed immediately -> retried
    expect(await run(60_000)).toBe(1); // still backing off -> skipped
  });

  it("grows backoff exponentially and resets it on success", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0

    const storage = makeStorage();
    const calls: unknown[] = [];
    let mode: "fail" | "ok" = "fail";
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      if (mode === "fail") throw new TransportError(429); // no Retry-After -> computed backoff
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 1,
    });

    client.track("a"); // attempt 1 fails -> backoff 2000ms
    await tick();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(1999);
    client.track("b"); // still inside 2000ms backoff -> skipped
    await tick();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(2); // now past 2000ms
    client.track("c"); // attempt 2 fails -> backoff grows to 4000ms
    await tick();
    expect(calls).toHaveLength(2);

    vi.advanceTimersByTime(2001);
    client.track("d"); // only 2001ms elapsed, backoff is now 4000ms -> skipped
    await tick();
    expect(calls).toHaveLength(2);

    vi.advanceTimersByTime(2000); // past the 4000ms window
    mode = "ok";
    client.track("e"); // attempt 3 succeeds -> resets failures + backoff
    await tick();
    expect(calls).toHaveLength(3);

    // Backoff cleared: a fresh size trigger flushes immediately (no wait).
    client.track("f");
    await tick();
    expect(calls).toHaveLength(4);
    client.stop();
  });

  it("drops the batch permanently on 400 (does not retry forever)", async () => {
    const storage = makeStorage();
    const calls: unknown[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      throw new TransportError(400);
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 20,
    });
    client.track("a");
    client.track("b");
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(queueLen(storage)).toBe(0); // batch dropped, not re-queued
    client.stop();
  });

  it("halves the effective batch size on 413 without dropping events", async () => {
    const storage = makeStorage();
    const batchLens: number[] = [];
    let fail = true;
    const transport: CohorlyTransport = async (_url, body) => {
      batchLens.push((body as unknown[]).length);
      if (fail) throw new TransportError(413);
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 8,
    });
    ["a", "b", "c", "d"].forEach((e) => client.track(e)); // queue=4, below batchSize 8

    await client.flush(); // batch min(8,4)=4, 413 -> halve 8->4
    expect(queueLen(storage)).toBe(4); // nothing dropped
    await client.flush(); // batch min(4,4)=4, 413 -> halve 4->2
    await client.flush(); // batch min(2,4)=2, 413 -> halve 2->1
    fail = false;
    await client.flush(); // batch min(1,4)=1, success

    expect(batchLens).toEqual([4, 4, 2, 1]);
    expect(queueLen(storage)).toBe(3); // one event flushed, three remain
    client.stop();
  });

  it("caps the persisted queue at maxQueueSize, dropping the oldest events", () => {
    const storage = makeStorage();
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport: async () => {},
      flushIntervalMs: 0,
      batchSize: 100_000, // never auto-flush
      maxQueueSize: 3,
    });
    ["a", "b", "c", "d", "e"].forEach((e) => client.track(e));

    const queued = JSON.parse(storage.get("cohorly_queue")!) as {
      event: string;
    }[];
    expect(queued.map((e) => e.event)).toEqual(["c", "d", "e"]);
    client.stop();
  });
});

describe("$device_id / $user_id", () => {
  it("stamps $device_id on every event and no $user_id while anonymous", () => {
    const { client } = makeClient();
    const evt = client.track("Anon Event");
    expect(evt.properties.$device_id).toBe(client.getDeviceId());
    expect("$user_id" in evt.properties).toBe(false);
  });

  it("keeps the same $device_id across identify and adds $user_id once identified", async () => {
    const { client } = makeClient();
    const deviceId = client.getDeviceId();
    await client.identify("user-42");
    const evt = client.track("After Identify");
    expect(evt.properties.$device_id).toBe(deviceId); // unchanged
    expect(evt.properties.$user_id).toBe("user-42");
    expect(evt.properties.distinct_id).toBe("user-42");
  });

  it("persists $device_id across client instances (survives identify + reload)", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeClient({ storage });
    const deviceId = c1.getDeviceId();
    await c1.identify("user-7");

    const { client: c2 } = makeClient({ storage });
    expect(c2.getDeviceId()).toBe(deviceId);
    expect(c2.track("x").properties.$device_id).toBe(deviceId);
  });

  it("reset() mints a fresh $device_id", () => {
    const { client } = makeClient();
    const before = client.getDeviceId();
    client.reset();
    expect(client.getDeviceId()).not.toBe(before);
    expect(client.track("y").properties.$device_id).toBe(client.getDeviceId());
  });

  it("does not override caller-supplied $device_id / $user_id", () => {
    const { client } = makeClient();
    const evt = client.track("Custom", {
      $device_id: "custom-device",
      $user_id: "custom-user",
    });
    expect(evt.properties.$device_id).toBe("custom-device");
    expect(evt.properties.$user_id).toBe("custom-user");
  });
});

describe("timed events", () => {
  it("attaches $duration (seconds, 3 decimals) then clears the timer", () => {
    const { client } = makeClient();
    const now = 1_000_000;
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(now);
    client.timeEvent("Checkout");
    spy.mockReturnValue(now + 2500); // 2.5s later
    const evt = client.track("Checkout");
    expect(evt.properties.$duration).toBe(2.5);

    // timer cleared: a second track has no $duration
    spy.mockReturnValue(now + 9999);
    const evt2 = client.track("Checkout");
    expect("$duration" in evt2.properties).toBe(false);
    spy.mockRestore();
  });

  it("only times the matching event name", () => {
    const { client } = makeClient();
    client.timeEvent("A");
    const other = client.track("B");
    expect("$duration" in other.properties).toBe(false);
  });

  it("clearTimedEvent / clearTimedEvents cancel pending timers", () => {
    const { client } = makeClient();
    client.timeEvent("A");
    client.timeEvent("B");
    client.clearTimedEvent("A");
    expect("$duration" in client.track("A").properties).toBe(false);
    expect("$duration" in client.track("B").properties).toBe(true);

    client.timeEvent("C");
    client.clearTimedEvents();
    expect("$duration" in client.track("C").properties).toBe(false);
  });

  it("persists timers across client instances", () => {
    const storage = makeStorage();
    const now = 500_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    const { client: c1 } = makeClient({ storage });
    c1.timeEvent("Reload");

    spy.mockReturnValue(now + 1000);
    const { client: c2 } = makeClient({ storage });
    expect(c2.track("Reload").properties.$duration).toBe(1);
    spy.mockRestore();
  });
});

describe("people", () => {
  it("people.set posts a $set engage payload", async () => {
    const { client, calls } = makeClient();
    await client.identify("user-1");
    await client.people.set({ name: "Ada" });

    const engageCall = calls.find((c) => c.url.endsWith("/engage"));
    expect(engageCall).toBeTruthy();
    expect(engageCall!.body).toEqual({
      distinct_id: "user-1",
      $set: { name: "Ada" },
    });
  });

  it("people.increment posts a $add engage payload", async () => {
    const { client, calls } = makeClient();
    await client.people.increment({ logins: 1 });
    const engageCall = calls.find((c) => c.url.endsWith("/engage"));
    expect(engageCall!.body).toMatchObject({ $add: { logins: 1 } });
  });
});
