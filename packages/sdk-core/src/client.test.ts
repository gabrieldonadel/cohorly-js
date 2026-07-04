import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "./client.js";
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
