import type { PeopleProperties } from "@cohorly/core";
import { CohorlyClient, fetchTransport } from "@cohorly/core";
import { getAttributionProperties, initAttribution } from "./attribution.js";
import type { AutocaptureConfig, AutocaptureOption } from "./autocapture.js";
import { setupAutocapture } from "./autocapture.js";
import { beaconTransport } from "./beacon.js";
import { getDefaultProperties } from "./defaults.js";
import {
  getPageviewProperties,
  PAGEVIEW_EVENT,
  setupPageviewAutotrack,
} from "./pageview.js";
import { localStorageAdapter } from "./storage.js";

export interface CohorlyWebOptions {
  /**
   * Base URL of the Cohorly ingestion API. Defaults to the hosted endpoint
   * (`https://cohorly-service.velloalabs.com`); only set this to point at a
   * different deployment.
   */
  apiHost?: string;
  flushIntervalMs?: number;
  batchSize?: number;
  debug?: boolean;
  /** Track a `$mp_web_page_view` event on init and on SPA route changes. */
  trackPageviews?: boolean;
  /**
   * Opt-in DOM autocapture (`$mp_click`/`$mp_submit`/`$mp_scroll`). Default off.
   * Pass `true` to enable all, or an object to fine-tune. Input values are never
   * captured; element text only when `captureTextContent` is set.
   */
  autocapture?: AutocaptureOption;
  /** Registered as super properties immediately after init. */
  superProperties?: Record<string, unknown>;
  /**
   * Project token. When set, stamped on every tracked event's properties and
   * included in every /engage and /alias body so the server can route data
   * to the right project.
   */
  token?: string;
  /** Max events retained in the persisted queue (drop oldest on overflow). Default 1000. */
  maxQueueSize?: number;
  /** Upper bound on retry backoff delay, in ms. Default 600000 (10 min). */
  maxRetryDelayMs?: number;
}

export interface Cohorly {
  track(event: string, properties?: Record<string, unknown>): void;
  identify(id: string): Promise<void>;
  reset(): void;
  register(props: Record<string, unknown>): void;
  unregister(key: string): void;
  /** Start a timer; the next `track()` of the same name attaches `$duration` (seconds). */
  timeEvent(event: string): void;
  /** Cancel a pending timed event. */
  clearTimedEvent(event: string): void;
  /** Cancel all pending timed events. */
  clearTimedEvents(): void;
  people: PeopleProperties;
  flush(): Promise<void>;
  getDistinctId(): string;
  isAnonymous(): boolean;
}

/**
 * Platform profile defaults auto-merged into every `people.set`/`setOnce`
 * (Mixpanel parity): device (`$os`/`$browser`/`$browser_version`) plus persisted
 * first-touch `$initial_referrer`/`$initial_referring_domain`. User-supplied keys
 * always win. Empty during SSR / before any first-touch is recorded.
 */
export function getProfileDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const device = getDefaultProperties();
  for (const key of ["$os", "$browser", "$browser_version"] as const) {
    if (device[key] !== undefined) out[key] = device[key];
  }
  const attribution = getAttributionProperties(localStorageAdapter);
  for (const key of ["$initial_referrer", "$initial_referring_domain"] as const) {
    if (attribution[key] !== undefined) out[key] = attribution[key];
  }
  return out;
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
    ensureClient().track(event, {
      ...getDefaultProperties(),
      ...getAttributionProperties(localStorageAdapter),
      ...properties,
    });
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
  timeEvent(event) {
    ensureClient().timeEvent(event);
  },
  clearTimedEvent(event) {
    ensureClient().clearTimedEvent(event);
  },
  clearTimedEvents() {
    ensureClient().clearTimedEvents();
  },
  people: {
    // $set / $set_once auto-merge platform profile defaults; caller keys win.
    set: (props) => ensureClient().people.set({ ...getProfileDefaults(), ...props }),
    setOnce: (props) =>
      ensureClient().people.setOnce({ ...getProfileDefaults(), ...props }),
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
    maxQueueSize: options.maxQueueSize,
    maxRetryDelayMs: options.maxRetryDelayMs,
  });

  if (options.superProperties) {
    activeClient.register(options.superProperties);
  }

  // Attribution: register UTM super props + persist first-touch (before any
  // event fires so pageviews carry the attribution props).
  initAttribution(localStorageAdapter, {
    register: (props) => activeClient?.register(props),
    setOnce: (props) => activeClient?.people.setOnce(props),
  });

  setupUnloadFlush(activeClient);

  const autocapture = setupAutocapture(
    (event, props) => cohorly.track(event, props),
    options.autocapture,
  );

  const trackPageview = () =>
    cohorly.track(PAGEVIEW_EVENT, getPageviewProperties());

  if (options.trackPageviews) trackPageview();

  if (options.trackPageviews || autocapture) {
    setupPageviewAutotrack(() => {
      autocapture?.resetScroll();
      if (options.trackPageviews) trackPageview();
    });
  }

  return cohorly;
}

export type {
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  EngageOp,
  PeopleProperties,
  TrackedEvent,
} from "@cohorly/core";
export { CohorlyClient, TransportError } from "@cohorly/core";
export {
  CAMPAIGN_PARAMS,
  getAttributionProperties,
  parseReferrer,
  parseUtm,
  referringDomain,
  UTM_PARAMS,
} from "./attribution.js";
export { getDefaultProperties } from "./defaults.js";
export { getPageviewProperties, PAGEVIEW_EVENT } from "./pageview.js";
export type { AutocaptureConfig, AutocaptureOption };
