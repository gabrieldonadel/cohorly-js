import { CohorlyClient, fetchTransport } from "@cohorly/core";
import type { PeopleProperties } from "@cohorly/core";
import { localStorageAdapter } from "./storage.js";
import { getDefaultProperties } from "./defaults.js";
import { beaconTransport } from "./beacon.js";
import { setupPageviewAutotrack } from "./pageview.js";

export interface CohorlyWebOptions {
  apiHost: string;
  flushIntervalMs?: number;
  batchSize?: number;
  debug?: boolean;
  /** Track an initial "Page View" event on init and on SPA route changes. */
  trackPageviews?: boolean;
  /** Registered as super properties immediately after init. */
  superProperties?: Record<string, unknown>;
  /**
   * Project token. When set, stamped on every tracked event's properties and
   * included in every /engage and /alias body so the server can route data
   * to the right project.
   */
  token?: string;
}

export interface Cohorly {
  track(event: string, properties?: Record<string, unknown>): void;
  identify(id: string): Promise<void>;
  reset(): void;
  register(props: Record<string, unknown>): void;
  unregister(key: string): void;
  people: PeopleProperties;
  flush(): Promise<void>;
  getDistinctId(): string;
  isAnonymous(): boolean;
}

let activeClient: CohorlyClient | null = null;

function ensureClient(): CohorlyClient {
  if (!activeClient) {
    throw new Error(
      "[cohorly] cohorly.* called before init(). Call init({ apiHost }) first.",
    );
  }
  return activeClient;
}

/** Named singleton, usable as `import { cohorly } from "@cohorly/web"` after init(). */
export const cohorly: Cohorly = {
  track(event, properties = {}) {
    ensureClient().track(event, { ...getDefaultProperties(), ...properties });
  },
  identify(id) {
    return ensureClient().identify(id);
  },
  reset() {
    ensureClient().reset();
  },
  register(props) {
    ensureClient().register(props);
  },
  unregister(key) {
    ensureClient().unregister(key);
  },
  people: {
    set: (props) => ensureClient().people.set(props),
    setOnce: (props) => ensureClient().people.setOnce(props),
    increment: (props) => ensureClient().people.increment(props),
    unset: (keys) => ensureClient().people.unset(keys),
    delete: () => ensureClient().people.delete(),
  },
  flush() {
    return ensureClient().flush();
  },
  getDistinctId() {
    return ensureClient().getDistinctId();
  },
  isAnonymous() {
    return ensureClient().isAnonymous();
  },
};

function setupUnloadFlush(client: CohorlyClient): void {
  if (typeof window === "undefined") return;
  const flushWithBeacon = () => {
    client.flush(beaconTransport).catch(() => {
      /* best effort during teardown */
    });
  };
  window.addEventListener("pagehide", flushWithBeacon);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWithBeacon();
  });
}

/** Initialize the web SDK. Safe to call during SSR (falls back to no-op browser APIs). */
export function init(options: CohorlyWebOptions): Cohorly {
  activeClient = new CohorlyClient({
    apiHost: options.apiHost,
    storage: localStorageAdapter,
    transport: fetchTransport,
    flushIntervalMs: options.flushIntervalMs,
    batchSize: options.batchSize,
    debug: options.debug,
    lib: "web",
    token: options.token,
  });

  if (options.superProperties) {
    activeClient.register(options.superProperties);
  }

  setupUnloadFlush(activeClient);

  if (options.trackPageviews) {
    cohorly.track("Page View");
    setupPageviewAutotrack(() => cohorly.track("Page View"));
  }

  return cohorly;
}

export { CohorlyClient } from "@cohorly/core";
export type {
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  EngageOp,
  PeopleProperties,
  TrackedEvent,
} from "@cohorly/core";
