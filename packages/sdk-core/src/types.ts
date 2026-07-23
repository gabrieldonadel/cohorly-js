/**
 * Ingestion contract shapes, copied from apps/server/src/types.ts to keep
 * this package standalone (see repo CLAUDE.md "Ownership" convention).
 */
export interface TrackedEvent {
  event: string;
  properties: {
    distinct_id: string;
    time?: number; // unix ms
    $insert_id?: string;
    [key: string]: unknown;
  };
}

export interface EngageOp {
  distinct_id: string;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
  $add?: Record<string, number>;
  /**
   * Destructive: the server refuses this op unless the request also carries an
   * admin credential (superadmin key, or a Firebase token for an org owner) in
   * the Authorization header. Refused ops are skipped individually; the server
   * still answers HTTP 200 with `{ status: 0, ..., refused }`, so from a
   * client-only SDK this is a silent no-op.
   */
  $unset?: string[];
  /** Destructive: same server-side credential requirement as `$unset`. */
  $delete?: boolean;
}

/** Storage abstraction injected by platform-specific SDKs (web/react-native/node). Synchronous. */
export interface CohorlyStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Transport abstraction injected by platform-specific SDKs. Defaults to fetch. */
export type CohorlyTransport = (url: string, body: unknown) => Promise<void>;

export interface CohorlyClientOptions {
  /**
   * Base URL of the Cohorly ingestion API. Defaults to the hosted endpoint
   * (`https://cohorly-service.velloalabs.com`); only set this to point at a
   * different deployment.
   */
  apiHost?: string;
  storage: CohorlyStorage;
  transport?: CohorlyTransport;
  flushIntervalMs?: number;
  batchSize?: number;
  debug?: boolean;
  /** Value stamped on every event as $lib. Defaults to "core". */
  lib?: string;
  /**
   * Project token (mixpanel-style). When set, stamped as `properties.token`
   * on every tracked event and included as a top-level `token` field on
   * every /engage and /alias body, so the server can resolve the event to
   * a project.
   */
  token?: string;
  /**
   * Maximum number of events retained in the persisted queue. On overflow the
   * OLDEST events are dropped (logged via debug). Defaults to 1000.
   */
  maxQueueSize?: number;
  /**
   * Upper bound on the retry backoff delay, in ms. Exponential backoff
   * (base 2000ms, doubling per consecutive failure) and any server-supplied
   * Retry-After are both capped at this value. Defaults to 600000 (10 min).
   */
  maxRetryDelayMs?: number;
}

export interface PeopleProperties {
  set(props: Record<string, unknown>): Promise<void>;
  setOnce(props: Record<string, unknown>): Promise<void>;
  increment(props: Record<string, number>): Promise<void>;
  /**
   * Destructive: the server only honors $unset when the request carries an
   * admin credential (org owner / superadmin), which browser and mobile SDKs
   * authenticated by the public project token do not have. Called from a
   * client SDK this is a server-side no-op; remove properties from the
   * dashboard or a server-side integration instead.
   */
  unset(keys: string[]): Promise<void>;
  /** Destructive: same server-side credential requirement as `unset()`. */
  delete(): Promise<void>;
}
