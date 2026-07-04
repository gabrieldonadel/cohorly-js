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
  $unset?: string[];
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
  apiHost: string;
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
}

export interface PeopleProperties {
  set(props: Record<string, unknown>): Promise<void>;
  setOnce(props: Record<string, unknown>): Promise<void>;
  increment(props: Record<string, number>): Promise<void>;
  unset(keys: string[]): Promise<void>;
  delete(): Promise<void>;
}
