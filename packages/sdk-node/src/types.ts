/**
 * Ingestion contract shapes, copied from apps/server/src/types.ts to keep
 * this package standalone (see repo CLAUDE.md "Ownership" convention).
 */
export type Properties = Record<string, unknown>;

/** Node-style callback: called with no args on success, an Error on failure. */
export type Callback = (err?: Error) => void;

/** A fully-stamped event as sent to POST /track. */
export interface TrackEvent {
  event: string;
  properties: Properties & {
    distinct_id: string;
    time: number; // unix ms
    $insert_id: string;
    $lib: string;
    $lib_version: string;
  };
}

/** Caller-supplied event for trackBatch/importBatch (before stamping). */
export interface BatchEventInput {
  event: string;
  properties: Properties & { distinct_id: string };
}

/** Body shape for POST /engage. */
export interface EngagePayload {
  distinct_id: string;
  $set?: Properties;
  $set_once?: Properties;
  $add?: Record<string, number>;
  $unset?: string[];
  $delete?: boolean;
}

/**
 * Transport abstraction: POSTs `body` as JSON to `url` with `headers`.
 * Must throw a TransportError on non-2xx responses. Injected in tests.
 */
export type CohorlyTransport = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<void>;

export interface CohorlyConfig {
  /** Base URL of the Cohorly ingestion server. Default "http://localhost:4000". */
  host?: string;
  /** Auto-flush the event queue every N ms. Default 5000. 0 disables the timer. */
  flushIntervalMs?: number;
  /** Flush once the queue reaches this many events. Default 20, clamped to
   * the server per-request cap of 500. */
  batchSize?: number;
  /** Log SDK activity via console.warn. Default false. */
  debug?: boolean;
  /** Max events retained in the in-memory queue (drop oldest on overflow). Default 1000. */
  maxQueueSize?: number;
  /** Upper bound on retry backoff delay, in ms. Default 600000 (10 min). */
  maxRetryDelayMs?: number;
  /** Custom transport, mainly for testing. Defaults to a fetch transport. */
  transport?: CohorlyTransport;
}

/**
 * Profile operations, mirroring mixpanel-node's `people` API (snake_case
 * canonical names + camelCase aliases), mapped to POST /engage ops.
 * `append`/`union`/`track_charge` are not supported by the Cohorly server
 * and intentionally absent.
 */
export interface CohorlyPeople {
  /** $set: set profile properties. Object form or single key/value form. */
  set(distinctId: string, properties: Properties, callback?: Callback): Promise<void>;
  set(distinctId: string, property: string, value: unknown, callback?: Callback): Promise<void>;

  /** $set_once: set only if not already present. */
  set_once(distinctId: string, properties: Properties, callback?: Callback): Promise<void>;
  set_once(distinctId: string, property: string, value: unknown, callback?: Callback): Promise<void>;
  setOnce(distinctId: string, properties: Properties, callback?: Callback): Promise<void>;
  setOnce(distinctId: string, property: string, value: unknown, callback?: Callback): Promise<void>;

  /** $add: increment numeric profile properties. Amount defaults to 1. */
  increment(distinctId: string, properties: Record<string, number>, callback?: Callback): Promise<void>;
  increment(distinctId: string, property: string, by?: number, callback?: Callback): Promise<void>;

  /** $unset: remove profile properties. */
  unset(distinctId: string, properties: string | string[], callback?: Callback): Promise<void>;

  /** $delete: delete the whole profile. */
  delete_user(distinctId: string, callback?: Callback): Promise<void>;
  deleteUser(distinctId: string, callback?: Callback): Promise<void>;
}
