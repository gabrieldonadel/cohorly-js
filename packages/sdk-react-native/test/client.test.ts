import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import { createFakeFetch, FakeStorage } from "./helpers.js";

describe("track payload shape", () => {
  it("includes distinct_id, time, $insert_id, $lib and merges super props", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.register({ app_version: "1.0.0" });
    client.track("Button Clicked", { button: "signup" });
    await client.flush();
    client.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/track");
    const [event] = requests[0].body as any[];
    expect(event.event).toBe("Button Clicked");
    expect(event.properties.button).toBe("signup");
    expect(event.properties.app_version).toBe("1.0.0");
    expect(event.properties.$lib).toBe("react-native");
    expect(typeof event.properties.distinct_id).toBe("string");
    expect(typeof event.properties.time).toBe("number");
    expect(typeof event.properties.$insert_id).toBe("string");
  });

  it("assigns a unique $insert_id per event", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    client.track("a");
    client.track("b");
    await client.flush();
    client.stop();

    const events = requests[0].body as any[];
    expect(events[0].properties.$insert_id).not.toBe(events[1].properties.$insert_id);
  });
});

describe("batching and auto-flush", () => {
  it("flushes automatically once flushAt is reached", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 3,
      flushInterval: 60_000,
    });
    await client.ready;
    client.track("e1");
    client.track("e2");
    expect(requests).toHaveLength(0);
    client.track("e3");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect((requests[0].body as any[]).length).toBe(3);
    client.stop();
  });

  it("flushes automatically on the flush interval timer", async () => {
    vi.useFakeTimers();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 20,
      flushInterval: 5000,
    });
    await client.ready;
    client.track("e1");
    await vi.advanceTimersByTimeAsync(5001);
    expect(requests).toHaveLength(1);
    client.stop();
    vi.useRealTimers();
  });

  it("re-queues events on send failure so they are retried", async () => {
    const failing = createFakeFetch({ fail: true });
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: failing.fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.track("e1");
    await client.flush();
    expect(failing.requests).toHaveLength(1);

    const ok = createFakeFetch();
    (client as any).fetchImpl = ok.fetchImpl;
    await client.flush();
    expect(ok.requests).toHaveLength(1);
    expect((ok.requests[0].body as any[])[0].event).toBe("e1");
    client.stop();
  });

  it("persists the queue to storage between flushes", async () => {
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    client.track("queued-event");
    const raw = await storage.getItem("cohorly:queue");
    expect(JSON.parse(raw as string)).toHaveLength(1);
    client.stop();
  });
});

describe("identify persistence", () => {
  it("persists the distinct id across client instances via shared storage", async () => {
    const storage = new FakeStorage();
    const client1 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client1.ready;
    client1.identify("user-42");
    client1.stop();

    const client2 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client2.ready;
    expect(client2.getDistinctId()).toBe("user-42");
    client2.stop();
  });

  it("reset() assigns a fresh anonymous id and clears super props", async () => {
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client.ready;
    client.identify("user-1");
    client.register({ plan: "pro" });
    const before = client.getDistinctId();
    client.reset();
    expect(client.getDistinctId()).not.toBe(before);
    expect(client.getDistinctId()).not.toBe("user-1");
    client.stop();
  });
});

describe("token", () => {
  it("stamps token onto every tracked event's properties", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      token: "proj_abc123",
    });
    await client.ready;
    client.track("Signed Up");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.token).toBe("proj_abc123");
  });

  it("includes token as a top-level field on /engage payloads", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      token: "proj_abc123",
    });
    await client.ready;
    client.identify("user-9");
    client.people.set({ plan: "pro" });
    await client.flush();
    client.stop();

    const engageCall = requests.find((r) => r.path === "/engage");
    const [payload] = engageCall!.body as any[];
    expect(payload.token).toBe("proj_abc123");
  });

  it("omits token entirely when not configured", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.track("No Token Event");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect("token" in event.properties).toBe(false);
  });
});

describe("people (engage) queue", () => {
  it("sends $set payloads to /engage", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.identify("user-9");
    client.people.set({ plan: "pro" });
    await client.flush();
    client.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/engage");
    const [payload] = requests[0].body as any[];
    expect(payload.distinct_id).toBe("user-9");
    expect(payload.$set).toEqual({ plan: "pro" });
  });
});
