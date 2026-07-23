export type Properties = Record<string, unknown>;

/** Minimal AsyncStorage-compatible interface. Matches
 * `@react-native-async-storage/async-storage`'s default export shape,
 * so it can be passed in directly without this package depending on it. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Device/platform info merged into every event's default properties. When
 * `options.platformInfo` is not provided, the client tries to derive this
 * lazily (and safely) from `react-native`'s `Platform`/`Dimensions` modules;
 * any field left undefined (e.g. because react-native isn't present, as in
 * plain Node/vitest) is simply omitted from the event properties.
 */
export interface PlatformInfo {
  /** Mapped from `Platform.OS`: "iOS" for "ios", "Android" for "android",
   * otherwise passed through as-is. */
  os?: string;
  /** `Platform.Version`. */
  osVersion?: string | number;
  /** `Dimensions.get("screen").height`. */
  screenHeight?: number;
  /** `Dimensions.get("screen").width`. */
  screenWidth?: number;
  /** Device model. Auto-derived when `react-native-device-info` or
   * `expo-device` is installed; an explicit value here always wins. */
  model?: string;
  /** Device manufacturer. Auto-derived when `react-native-device-info` or
   * `expo-device` is installed (always `"Apple"` on iOS); an explicit value
   * here always wins. */
  manufacturer?: string;
  /** Device brand (Android only). Auto-derived when `react-native-device-info`
   * or `expo-device` is installed; an explicit value here always wins. */
  brand?: string;
  /** Mobile carrier name. Auto-derived when `react-native-device-info` is
   * installed; an explicit value here always wins. */
  carrier?: string;
  /** Wifi connectivity. Auto-derived when `@react-native-community/netinfo`
   * is installed; an explicit value here always wins. */
  wifi?: boolean;
}

/** Minimal `AppState`-compatible interface (matches React Native's `AppState`
 * shape) so tests and non-RN environments can inject a fake implementation. */
export interface AppStateLike {
  addEventListener(event: "change", callback: (state: string) => void): unknown;
  currentState?: string;
}

export interface CohorlyOptions {
  /**
   * Base URL of the Cohorly ingestion API. Defaults to the hosted endpoint
   * (`https://cohorly-service.velloalabs.com`); only set this to point at a
   * different deployment.
   */
  apiHost?: string;
  /** Injected AsyncStorage-like implementation. Defaults to an in-memory store. */
  storage?: AsyncStorageLike;
  /** Flush queue after this many ms. Default 5000. */
  flushInterval?: number;
  /** Flush queue once it reaches this many events. Default 20. */
  flushAt?: number;
  /** Custom fetch implementation, mainly for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Disable all network calls (still queues + persists). Useful for tests. */
  disabled?: boolean;
  /**
   * Project token. When set, stamped on every tracked event's properties and
   * included as a top-level `token` field on every /engage body, so the
   * server can route data to the right project.
   */
  token?: string;
  /** Max events retained in the persisted queue (drop oldest on overflow). Default 1000. */
  maxQueueSize?: number;
  /** Upper bound on retry backoff delay, in ms. Default 600000 (10 min). */
  maxRetryDelayMs?: number;
  /** App version string, sent as `$app_version_string` and used to detect
   * `$ae_updated`. Auto-derived when `react-native-device-info` or
   * `expo-application` is installed; an explicit value here always wins. */
  appVersion?: string;
  /** App build number/string, sent as `$app_build_number`. Auto-derived when
   * `react-native-device-info` or `expo-application` is installed; an
   * explicit value here always wins. */
  appBuild?: string;
  /** When true, tracks `$ae_first_open`, `$ae_updated`, and `$ae_session`
   * automatic lifecycle events. Default false (opt-in). */
  trackAutomaticEvents?: boolean;
  /** Static device/platform info to merge into default properties, bypassing
   * the lazy `react-native` require. Mainly for tests and non-RN callers. */
  platformInfo?: PlatformInfo;
  /** Injected `AppState`-like implementation. Defaults to lazily requiring
   * `react-native`'s `AppState`. Mainly for tests and non-RN callers. */
  appState?: AppStateLike;
}

export interface TrackEvent {
  event: string;
  properties: Properties & {
    distinct_id: string;
    time: number;
    $insert_id: string;
    $lib: string;
  };
}

export interface EngagePayload {
  distinct_id: string;
  $set?: Properties;
  $set_once?: Properties;
  $add?: Properties;
  $unset?: string[];
  $delete?: boolean;
  token?: string;
}
