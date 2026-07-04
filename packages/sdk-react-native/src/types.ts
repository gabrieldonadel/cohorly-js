export type Properties = Record<string, unknown>;

/** Minimal AsyncStorage-compatible interface. Matches
 * `@react-native-async-storage/async-storage`'s default export shape,
 * so it can be passed in directly without this package depending on it. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface CohorlyOptions {
  /** Base URL of the Cohorly ingestion server, e.g. "http://localhost:4000". */
  apiHost: string;
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
