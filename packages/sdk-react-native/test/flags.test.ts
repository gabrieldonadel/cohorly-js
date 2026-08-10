import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import type { FlagResult } from "../src/types.js";
import { type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

const FLAGS = {
  checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
  banner: {
    enabled: true,
    variant: "blue",
    payload: { color: "#00f" },
    reason: "rule:0",
  },
};

/** Fake fetch that answers /flags/evaluate with `flags`, everything else 200. */
function createFlagsFetch(flags: unknown = FLAGS, status = 200) {
  const requests: FakeRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ path, body });
    if (path === "/flags/evaluate") {
      return new Response(JSON.stringify({ flags }), { status });
    }
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

function makeClient(
  fetchImpl: typeof fetch,
  storage: FakeStorage,
  options: Record<string, unknown> = {},
) {
  return new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "tok-rn",
    storage,
    fetch: fetchImpl,
    ...options,
  });
}

describe("react-native feature flags", () => {
  it("evaluates flags on init and exposes the results", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage());
    await client.ready;
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1),
    );
    client.stop();

    expect(requestsTo(requests, "/flags/evaluate")[0].body).toEqual({
      distinct_id: client.getDistinctId(),
      token: "tok-rn",
    });
    await vi.waitFor(() => expect(client.isFeatureEnabled("checkout")).toBe(true));
    expect(client.getFeatureFlag("banner")).toBe("blue");
    expect(client.getFeatureFlagPayload("banner")).toEqual({ color: "#00f" });
    expect(client.getFeatureFlag("nope")).toBe(false);
    expect(client.isFeatureEnabled("nope")).toBe(false);
    expect(client.getFeatureFlagPayload("nope")).toBeNull();
  });

  it("loadFeatureFlags: false skips the initial evaluation; manual reload still works", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage(), {
      loadFeatureFlags: false,
    });
    await client.ready;
    await new Promise((r) => setTimeout(r, 10));
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(0);

    await client.reloadFeatureFlags();
    client.stop();
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1);
    expect(client.isFeatureEnabled("checkout")).toBe(true);
  });

  it("persists the cache scoped by distinct id and rehydrates it on the next launch", async () => {
    const storage = new FakeStorage();
    const first = makeClient(createFlagsFetch().fetchImpl, storage);
    await first.ready;
    await vi.waitFor(() => expect(first.isFeatureEnabled("checkout")).toBe(true));
    first.stop();

    const cached = JSON.parse(storage.store.get("cohorly:flags") as string);
    expect(cached.distinct_id).toBe(first.getDistinctId());

    // Fresh client, same storage, flag endpoint now unreachable: the persisted
    // cache is served immediately.
    const second = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
    );
    await second.ready;
    second.stop();
    expect(second.isFeatureEnabled("checkout")).toBe(true);
    expect(second.getFeatureFlag("banner")).toBe("blue");
  });

  it("drops a cache belonging to a different distinct id", async () => {
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-a");
    await storage.setItem("cohorly:anonymous", "0");
    await storage.setItem(
      "cohorly:flags",
      JSON.stringify({ distinct_id: "someone-else", flags: FLAGS }),
    );

    const client = makeClient(createFlagsFetch({}).fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await client.ready;
    client.stop();
    expect(client.isFeatureEnabled("checkout")).toBe(false);
    expect(storage.store.has("cohorly:flags")).toBe(false);
  });

  it("re-evaluates on identify() and clears + re-evaluates on reset()", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;

    client.identify("user-1");
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1),
    );
    expect(requestsTo(requests, "/flags/evaluate")[0].body).toMatchObject({
      distinct_id: "user-1",
    });
    await vi.waitFor(() => expect(client.isFeatureEnabled("checkout")).toBe(true));

    client.reset();
    // Cleared synchronously, before the refresh lands.
    expect(client.isFeatureEnabled("checkout")).toBe(false);
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(2),
    );
    client.stop();
    expect(requestsTo(requests, "/flags/evaluate")[1].body).toMatchObject({
      distinct_id: client.getDistinctId(),
    });
  });

  it("keeps the stale cache when a reload fails, and never rejects", async () => {
    const storage = new FakeStorage();
    const client = makeClient(createFlagsFetch().fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await client.ready;
    await client.reloadFeatureFlags();
    expect(client.isFeatureEnabled("checkout")).toBe(true);

    // Non-2xx, then a network throw, then a malformed body: all swallowed.
    const failing = makeClient(createFlagsFetch(FLAGS, 429).fetchImpl, storage);
    await failing.ready;
    await expect(failing.reloadFeatureFlags()).resolves.toBeUndefined();
    failing.stop();

    const throwing = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
    );
    await throwing.ready;
    await expect(throwing.reloadFeatureFlags()).resolves.toBeUndefined();
    throwing.stop();
    // The cache written by the successful reload is still served.
    expect(throwing.isFeatureEnabled("checkout")).toBe(true);

    const malformed = makeClient(createFlagsFetch("not-an-object").fetchImpl, storage);
    await malformed.ready;
    await expect(malformed.reloadFeatureFlags()).resolves.toBeUndefined();
    malformed.stop();
    expect(malformed.isFeatureEnabled("checkout")).toBe(true);

    client.stop();
  });

  it("onFeatureFlags fires on reload, immediately when loaded, and unsubscribes", async () => {
    const { fetchImpl } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage(), {
      loadFeatureFlags: false,
    });
    await client.ready;

    const seen: Record<string, FlagResult>[] = [];
    const unsubscribe = client.onFeatureFlags((flags) => seen.push(flags));
    expect(seen).toHaveLength(0); // nothing loaded yet

    await client.reloadFeatureFlags();
    expect(seen).toHaveLength(1);
    expect(seen[0].banner.variant).toBe("blue");

    // Already loaded: a late subscriber fires immediately.
    let late = 0;
    const unsubscribeLate = client.onFeatureFlags(() => {
      late += 1;
    });
    expect(late).toBe(1);
    unsubscribeLate();

    unsubscribe();
    await client.reloadFeatureFlags();
    client.stop();
    expect(seen).toHaveLength(1);
  });

  /** The `$feature_flag_called` events queued so far, in order. */
  function exposures(requests: FakeRequest[], storage: FakeStorage) {
    const queued = JSON.parse(storage.store.get("cohorly:queue") ?? "[]") as {
      event: string;
      properties: Record<string, unknown>;
    }[];
    const sent = requestsTo(requests, "/track").flatMap(
      (r) => (r.body as { event: string; properties: Record<string, unknown> }[]) ?? [],
    );
    return [...sent, ...queued].filter((e) => e.event === "$feature_flag_called");
  }

  it("tracks one exposure per flag value, refiring when the value changes", async () => {
    let flags: unknown = FLAGS;
    const requests: FakeRequest[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, body });
      if (path === "/flags/evaluate") {
        return new Response(JSON.stringify({ flags }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;

    client.getFeatureFlag("banner"); // not loaded yet: no exposure
    await client.reloadFeatureFlags();

    client.getFeatureFlag("banner");
    client.getFeatureFlag("banner");
    client.isFeatureEnabled("banner");
    client.getFeatureFlagPayload("banner"); // payload reads never expose
    client.getFeatureFlag("nope"); // unknown key never exposes
    expect(exposures(requests, storage)).toHaveLength(1);
    expect(exposures(requests, storage)[0].properties).toMatchObject({
      $feature_flag: "banner",
      $feature_flag_response: "blue",
    });

    flags = {
      banner: { enabled: true, variant: "red", payload: null, reason: "rule:1" },
    };
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");
    client.stop();

    const fired = exposures(requests, storage);
    expect(fired).toHaveLength(2);
    expect(fired[1].properties.$feature_flag_response).toBe("red");
  });

  it("clears the exposure dedup on identify() and reset()", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;
    await client.reloadFeatureFlags();
    client.isFeatureEnabled("checkout");
    // Flushed after each read so reset()'s queue clear cannot hide an exposure.
    await client.flush();
    expect(exposures(requests, storage)).toHaveLength(1);

    client.identify("user-1");
    await client.reloadFeatureFlags();
    client.isFeatureEnabled("checkout");
    await client.flush();
    expect(exposures(requests, storage)).toHaveLength(2);

    client.reset();
    await client.reloadFeatureFlags();
    client.isFeatureEnabled("checkout");
    await client.flush();
    client.stop();
    expect(exposures(requests, storage)).toHaveLength(3);
  });

  it("sendExposureEvents: false silences exposures", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, {
      loadFeatureFlags: false,
      sendExposureEvents: false,
    });
    await client.ready;
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");
    client.isFeatureEnabled("checkout");
    client.stop();
    expect(exposures(requests, storage)).toHaveLength(0);
  });

  it("makes no flag request when disabled", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage(), { disabled: true });
    await client.ready;
    await client.reloadFeatureFlags();
    client.stop();
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(0);
  });
});
