import { describe, expect, it } from "vitest";
import { CohorlyClient } from "../src/client.js";
import { createFakeFetch, FakeStorage } from "./helpers.js";

/** Minimal AppState-like fake: exposes `emit()` so tests can simulate
 * foreground/background transitions without a real react-native module. */
function createFakeAppState() {
  let listener: ((state: string) => void) | undefined;
  return {
    addEventListener: (event: "change", cb: (state: string) => void) => {
      if (event === "change") listener = cb;
    },
    emit: (state: string) => listener?.(state),
  };
}

function findEvent(requests: { path: string; body: unknown }[], name: string) {
  return requests
    .filter((r) => r.path === "/track")
    .flatMap((r) => r.body as any[])
    .find((e) => e.event === name);
}

describe("device default properties (platformInfo)", () => {
  it("merges platformInfo, appVersion, appBuild and $lib_version into every event", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      appVersion: "1.2.3",
      appBuild: "42",
      platformInfo: {
        os: "iOS",
        osVersion: "17.0",
        screenHeight: 844,
        screenWidth: 390,
        model: "iPhone15,3",
        manufacturer: "Apple",
      },
    });
    await client.ready;
    client.track("Screen Viewed");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.$os).toBe("iOS");
    expect(event.properties.$os_version).toBe("17.0");
    expect(event.properties.$screen_height).toBe(844);
    expect(event.properties.$screen_width).toBe(390);
    expect(event.properties.$model).toBe("iPhone15,3");
    expect(event.properties.$manufacturer).toBe("Apple");
    expect(event.properties.$app_version_string).toBe("1.2.3");
    expect(event.properties.$app_build_number).toBe("42");
    expect(typeof event.properties.$lib_version).toBe("string");
  });

  it("omits device props entirely when platformInfo/appVersion/appBuild are absent (no react-native in test env)", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.track("No Device Info");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect("$os" in event.properties).toBe(false);
    expect("$app_version_string" in event.properties).toBe(false);
    expect(typeof event.properties.$lib_version).toBe("string");
  });

  it("emits $carrier, $brand and $wifi when present on platformInfo", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      platformInfo: { carrier: "Vivo", brand: "Apple", wifi: true },
    });
    await client.ready;
    client.track("Screen Viewed");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.$carrier).toBe("Vivo");
    expect(event.properties.$brand).toBe("Apple");
    expect(event.properties.$wifi).toBe(true);
  });

  it("omits $carrier, $brand and $wifi when absent", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.track("No Device Info");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect("$carrier" in event.properties).toBe(false);
    expect("$brand" in event.properties).toBe(false);
    expect("$wifi" in event.properties).toBe(false);
  });

  it("lets explicit per-event properties override device defaults", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      platformInfo: { os: "iOS" },
    });
    await client.ready;
    client.track("Custom Os", { $os: "custom" });
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.$os).toBe("custom");
  });
});

describe("trackAutomaticEvents: $ae_first_open / $ae_updated", () => {
  it("does not fire any automatic events when trackAutomaticEvents is false (default)", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      appVersion: "1.0.0",
    });
    await client.ready;
    await client.flush();
    client.stop();

    expect(requests.flatMap((r) => r.body as any[])).toHaveLength(0);
  });

  it("fires $ae_first_open exactly once ever (persisted flag)", async () => {
    const storage = new FakeStorage();

    const client1 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
    });
    await client1.ready;
    await client1.flush(); // deliver $ae_first_open, clearing the persisted queue
    client1.stop();

    const { fetchImpl, requests } = createFakeFetch();
    const client2 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
    });
    await client2.ready;
    await client2.flush();
    client2.stop();

    expect(findEvent(requests, "$ae_first_open")).toBeUndefined();
  });

  it("fires $ae_first_open on the very first init when trackAutomaticEvents is true", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
    });
    await client.ready;
    await client.flush();
    client.stop();

    expect(findEvent(requests, "$ae_first_open")).toBeDefined();
  });

  it("does not fire $ae_updated on first ever open even with appVersion set", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appVersion: "1.0.0",
    });
    await client.ready;
    await client.flush();
    client.stop();

    expect(findEvent(requests, "$ae_updated")).toBeUndefined();
  });

  it("fires $ae_updated with $ae_updated_version when appVersion changes across inits", async () => {
    const storage = new FakeStorage();

    const client1 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appVersion: "1.0.0",
    });
    await client1.ready;
    client1.stop();

    const { fetchImpl, requests } = createFakeFetch();
    const client2 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appVersion: "2.0.0",
    });
    await client2.ready;
    await client2.flush();
    client2.stop();

    const updated = findEvent(requests, "$ae_updated");
    expect(updated).toBeDefined();
    expect(updated.properties.$ae_updated_version).toBe("2.0.0");
  });

  it("skips $ae_updated silently when appVersion is absent", async () => {
    const storage = new FakeStorage();

    const client1 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
    });
    await client1.ready;
    client1.stop();

    const { fetchImpl, requests } = createFakeFetch();
    const client2 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
    });
    await client2.ready;
    await client2.flush();
    client2.stop();

    expect(findEvent(requests, "$ae_updated")).toBeUndefined();
  });
});

describe("trackAutomaticEvents: $ae_session via AppState", () => {
  it("fires $ae_session with $ae_session_length on active -> background after >= 10s", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appState,
    });
    await client.ready;
    await client.flush(); // deliver $ae_first_open before simulating a background transition

    const start = Date.now();
    const nowSpy = start + 15_000;
    (client as any).sessionStartedAt = start;
    const originalNow = Date.now;
    Date.now = () => nowSpy;
    try {
      appState.emit("background");
    } finally {
      Date.now = originalNow;
    }
    await client.flush();
    client.stop();

    const session = findEvent(requests, "$ae_session");
    expect(session).toBeDefined();
    expect(session.properties.$ae_session_length).toBe(15);
  });

  it("increments both $ae_total_app_sessions and $ae_total_app_session_length on a qualifying session", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appState,
    });
    await client.ready;
    await client.flush(); // deliver $ae_first_open before simulating a background transition

    const start = Date.now();
    (client as any).sessionStartedAt = start;
    const originalNow = Date.now;
    Date.now = () => start + 15_000;
    try {
      appState.emit("background");
    } finally {
      Date.now = originalNow;
    }
    await client.flush();
    client.stop();

    const engage = requests
      .filter((r) => r.path === "/engage")
      .flatMap((r) => r.body as any[])
      .find((p) => p.$add?.$ae_total_app_sessions !== undefined);
    expect(engage).toBeDefined();
    expect(engage.$add.$ae_total_app_sessions).toBe(1);
    expect(engage.$add.$ae_total_app_session_length).toBe(15);
  });

  it("does not fire $ae_session when foreground duration is under 10s", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appState,
    });
    await client.ready;
    await client.flush(); // deliver $ae_first_open before simulating a background transition

    (client as any).sessionStartedAt = Date.now();
    appState.emit("background");
    await client.flush();
    client.stop();

    expect(findEvent(requests, "$ae_session")).toBeUndefined();
  });

  it("does not fire $ae_session when trackAutomaticEvents is false, but still flushes on background", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      appState,
    });
    await client.ready;
    client.track("queued");
    (client as any).sessionStartedAt = Date.now() - 20_000;
    appState.emit("background");
    await client.flush();
    client.stop();

    expect(findEvent(requests, "$ae_session")).toBeUndefined();
    // Background transition still triggers the existing flush-on-background behavior.
    expect(findEvent(requests, "queued")).toBeDefined();
  });

  it("does not double count a session on active -> inactive -> background", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appState,
    });
    await client.ready;
    await client.flush(); // deliver $ae_first_open before simulating a background transition

    (client as any).sessionStartedAt = Date.now() - 20_000;
    appState.emit("inactive");
    appState.emit("background");
    await client.flush();
    client.stop();

    const sessions = requests
      .flatMap((r) => r.body as any[])
      .filter((e) => e.event === "$ae_session");
    expect(sessions).toHaveLength(1);
  });

  it("resets the session clock on background -> active", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
      trackAutomaticEvents: true,
      appState,
    });
    await client.ready;
    await client.flush(); // deliver $ae_first_open before simulating a background transition

    (client as any).sessionStartedAt = Date.now() - 20_000;
    appState.emit("background");
    await client.flush();

    // Coming back active resets the clock; going background again right away
    // should not produce a second >=10s session.
    appState.emit("active");
    appState.emit("background");
    await client.flush();
    client.stop();

    const sessions = requests
      .flatMap((r) => r.body as any[])
      .filter((e) => e.event === "$ae_session");
    expect(sessions).toHaveLength(1);
  });
});
