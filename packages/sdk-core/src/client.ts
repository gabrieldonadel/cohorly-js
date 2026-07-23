import { fetchTransport, TransportError } from "./transport.js";
import type {
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  PeopleProperties,
  TrackedEvent,
} from "./types.js";
import { uuid } from "./uuid.js";

const KEY_DISTINCT_ID = "cohorly_distinct_id";
const KEY_DEVICE_ID = "cohorly_device_id";
const KEY_ANONYMOUS = "cohorly_anonymous";
const KEY_SUPER_PROPS = "cohorly_super_props";
const KEY_QUEUE = "cohorly_queue";
const KEY_TIMED_EVENTS = "cohorly_timed_events";

/** Cohorly's hosted ingestion API. Used when no apiHost is supplied. */
const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const BACKOFF_BASE_MS = 2000;

/**
 * Transport/storage-agnostic analytics client. Platform SDKs (web, react-native, node)
 * inject a concrete CohorlyStorage + CohorlyTransport and layer platform defaults on top.
 */
export class CohorlyClient {
  private readonly apiHost: string;
  private readonly storage: CohorlyStorage;
  private readonly transport: CohorlyTransport;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly lib: string;
  private readonly token: string | undefined;
  private readonly maxQueueSize: number;
  private readonly maxRetryDelayMs: number;

  private distinctId: string;
  /**
   * Stable per-device/browser id (Mixpanel `$device_id`). Minted on first run,
   * persisted, and preserved across identify(); reset() mints a new one.
   */
  private deviceId: string;
  private anonymous: boolean;
  private superProps: Record<string, unknown>;
  /** Timed-event start timestamps (ms) keyed by event name. See timeEvent(). */
  private timedEvents: Record<string, number>;
  private queue: TrackedEvent[];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  /** Consecutive flush failures, drives exponential backoff. Reset on success. */
  private consecutiveFailures = 0;
  /** Timestamp (ms) before which non-forced flushes are skipped. */
  private backoffUntil = 0;
  /** Current effective per-flush batch size; halved on 413 (floor 1). */
  private effectiveBatchSize: number;

  readonly people: PeopleProperties;

  constructor(options: CohorlyClientOptions) {
    this.apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
    this.storage = options.storage;
    this.transport = options.transport ?? fetchTransport;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 20;
    this.debug = options.debug ?? false;
    this.lib = options.lib ?? "core";
    this.token = options.token;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.effectiveBatchSize = this.batchSize;

    const storedId = this.storage.get(KEY_DISTINCT_ID);
    if (storedId) {
      this.distinctId = storedId;
      this.anonymous = this.storage.get(KEY_ANONYMOUS) === "1";
    } else {
      this.distinctId = uuid();
      this.anonymous = true;
      this.storage.set(KEY_DISTINCT_ID, this.distinctId);
      this.storage.set(KEY_ANONYMOUS, "1");
    }

    // Device id: persisted separately so it survives identify(). For a fresh
    // install it equals the anon distinct id (Mixpanel's `$device:<uuid>`
    // convention); older installs migrating in mint a fresh one.
    const storedDevice = this.storage.get(KEY_DEVICE_ID);
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      this.deviceId = this.anonymous ? this.distinctId : uuid();
      this.storage.set(KEY_DEVICE_ID, this.deviceId);
    }

    this.superProps = this.readJson(KEY_SUPER_PROPS, {});
    this.timedEvents = this.readJson(KEY_TIMED_EVENTS, {});
    this.queue = this.readJson(KEY_QUEUE, []);
    // Enforce the persisted cap on load in case an older/larger queue was stored.
    if (this.enforceQueueCap()) this.persistQueue();

    this.people = {
      set: (props) => this.sendEngage({ $set: props }),
      setOnce: (props) => this.sendEngage({ $set_once: props }),
      increment: (props) => this.sendEngage({ $add: props }),
      unset: (keys) => this.sendEngage({ $unset: keys }),
      delete: () => this.sendEngage({ $delete: true }),
    };

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.maybeFlush();
      }, this.flushIntervalMs);
      // Don't keep the Node process alive just for the flush timer.
      const timer = this.flushTimer as { unref?: () => void };
      timer.unref?.();
    }
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  /** Stable per-device id stamped as `$device_id` on every event. */
  getDeviceId(): string {
    return this.deviceId;
  }

  isAnonymous(): boolean {
    return this.anonymous;
  }

  /**
   * Start a timer for `event`. The next `track(event)` of the same name attaches
   * `$duration` (seconds elapsed, 3 decimals) and clears the timer. Mirrors
   * Mixpanel's `time_event`. Timers are persisted so they survive a reload.
   */
  timeEvent(event: string): void {
    this.timedEvents[event] = Date.now();
    this.persistTimedEvents();
  }

  /** Cancel a pending timed event started via timeEvent(). */
  clearTimedEvent(event: string): void {
    if (event in this.timedEvents) {
      delete this.timedEvents[event];
      this.persistTimedEvents();
    }
  }

  /** Cancel all pending timed events. */
  clearTimedEvents(): void {
    this.timedEvents = {};
    this.persistTimedEvents();
  }

  track(event: string, properties: Record<string, unknown> = {}): TrackedEvent {
    // Timed events: if a timer was started for this name, attach $duration
    // (seconds, 3 decimals) and clear it.
    let duration: number | undefined;
    const startedAt = this.timedEvents[event];
    if (startedAt !== undefined) {
      duration = Math.round(((Date.now() - startedAt) / 1000) * 1000) / 1000;
      delete this.timedEvents[event];
      this.persistTimedEvents();
    }

    const props: TrackedEvent["properties"] = {
      ...this.superProps,
      ...properties,
      ...(duration !== undefined ? { $duration: duration } : {}),
      distinct_id: this.distinctId,
      time: Date.now(),
      $insert_id: uuid(),
      $lib: this.lib,
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    // Reserved identity fields, stamped last but never overriding a value the
    // caller passed explicitly (mirrors Mixpanel's $device_id/$user_id).
    if (props.$device_id === undefined) props.$device_id = this.deviceId;
    if (!this.anonymous && props.$user_id === undefined) {
      props.$user_id = this.distinctId;
    }
    const evt: TrackedEvent = { event, properties: props };
    this.queue.push(evt);
    this.enforceQueueCap();
    this.persistQueue();
    if (this.queue.length >= this.batchSize) {
      this.maybeFlush();
    }
    return evt;
  }

  async identify(id: string): Promise<void> {
    if (id === this.distinctId) return;
    if (this.anonymous) {
      const previousId = this.distinctId;
      try {
        await this.transport(`${this.apiHost}/alias`, {
          alias: previousId,
          distinct_id: id,
          ...(this.token !== undefined ? { token: this.token } : {}),
        });
      } catch (err) {
        this.log("alias request failed", err);
      }
    }
    this.distinctId = id;
    this.anonymous = false;
    this.storage.set(KEY_DISTINCT_ID, this.distinctId);
    this.storage.set(KEY_ANONYMOUS, "0");
  }

  reset(): void {
    this.distinctId = uuid();
    this.deviceId = this.distinctId;
    this.anonymous = true;
    this.storage.set(KEY_DISTINCT_ID, this.distinctId);
    this.storage.set(KEY_DEVICE_ID, this.deviceId);
    this.storage.set(KEY_ANONYMOUS, "1");
    this.clearTimedEvents();
  }

  register(props: Record<string, unknown>): void {
    this.superProps = { ...this.superProps, ...props };
    this.storage.set(KEY_SUPER_PROPS, JSON.stringify(this.superProps));
  }

  unregister(key: string): void {
    if (!(key in this.superProps)) return;
    const next = { ...this.superProps };
    delete next[key];
    this.superProps = next;
    this.storage.set(KEY_SUPER_PROPS, JSON.stringify(this.superProps));
  }

  /**
   * Manually flush the queue. This always attempts a send, even while in
   * backoff (a manual flush is treated as an explicit "try now" request).
   * Auto-flush (timer) and size-triggered flushes go through the internal
   * backoff-aware path and are skipped until the backoff deadline passes.
   */
  async flush(transportOverride?: CohorlyTransport): Promise<void> {
    return this.doFlush(transportOverride, true);
  }

  /** Backoff-aware flush used by the auto-flush timer and size triggers. */
  private maybeFlush(): void {
    this.doFlush(undefined, false).catch((err) =>
      this.log("auto-flush failed", err),
    );
  }

  private async doFlush(
    transportOverride: CohorlyTransport | undefined,
    force: boolean,
  ): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (!force && Date.now() < this.backoffUntil) return;
    this.flushing = true;
    try {
      const size = Math.max(1, this.effectiveBatchSize);
      const batch = this.queue.slice(0, size);
      const send = transportOverride ?? this.transport;
      try {
        await send(`${this.apiHost}/track`, batch);
        this.queue = this.queue.slice(batch.length);
        this.persistQueue();
        // Success: clear failure state and backoff.
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        this.handleFlushError(err, batch.length);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Applies the retry contract to a failed flush. `batchLen` is how many events
   * were in the just-attempted batch (front of the queue).
   *
   * - 400: payload permanently rejected - drop that batch, do not retry it.
   * - 413: payload too big - halve the effective batch size (floor 1), keep
   *   the queue, retry smaller next time (no backoff).
   * - 401: invalid token - keep queue, warn, backoff at max delay.
   * - 429 / 5xx / network: keep queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(err: unknown, batchLen: number): void {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      this.log("dropping batch permanently rejected with 400", err);
      this.queue = this.queue.slice(batchLen);
      this.persistQueue();
      return;
    }

    if (status === 413) {
      this.effectiveBatchSize = Math.max(1, Math.floor(this.effectiveBatchSize / 2));
      this.log(
        "payload too large (413), halving batch size to",
        this.effectiveBatchSize,
      );
      // Keep queue intact; next flush retries with the smaller batch.
      return;
    }

    this.consecutiveFailures += 1;
    let delay = this.computeBackoffMs();
    if (status === 401) {
      delay = this.maxRetryDelayMs;
      this.log("invalid token (401), keeping queue and backing off at max delay");
    } else if (
      status === 429 &&
      err instanceof TransportError &&
      err.retryAfterMs !== undefined
    ) {
      delay = Math.min(err.retryAfterMs, this.maxRetryDelayMs);
    }
    this.backoffUntil = Date.now() + delay;
    this.log("flush failed, keeping queue and backing off", {
      status,
      delayMs: delay,
      consecutiveFailures: this.consecutiveFailures,
    });
  }

  /**
   * Exponential backoff with base 2000ms, doubling per consecutive failure,
   * capped at maxRetryDelayMs, with +/-20% jitter.
   */
  private computeBackoffMs(): number {
    const exp = BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1);
    const capped = Math.min(exp, this.maxRetryDelayMs);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  /**
   * Trims the queue to `maxQueueSize`, dropping the OLDEST events on overflow.
   * Returns true if anything was dropped.
   */
  private enforceQueueCap(): boolean {
    if (this.queue.length <= this.maxQueueSize) return false;
    const overflow = this.queue.length - this.maxQueueSize;
    this.queue.splice(0, overflow);
    this.log("queue cap exceeded, dropped oldest events", overflow);
    return true;
  }

  /** Base URL events are sent to, e.g. for building a sendBeacon URL. */
  getApiHost(): string {
    return this.apiHost;
  }

  /** Stop the auto-flush timer. Useful in tests / on app teardown. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  private async sendEngage(op: Record<string, unknown>): Promise<void> {
    try {
      await this.transport(`${this.apiHost}/engage`, {
        distinct_id: this.distinctId,
        ...op,
        ...(this.token !== undefined ? { token: this.token } : {}),
      });
    } catch (err) {
      this.log("engage request failed", err);
    }
  }

  private persistQueue(): void {
    this.storage.set(KEY_QUEUE, JSON.stringify(this.queue));
  }

  private persistTimedEvents(): void {
    this.storage.set(KEY_TIMED_EVENTS, JSON.stringify(this.timedEvents));
  }

  private readJson<T>(key: string, fallback: T): T {
    const raw = this.storage.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.warn("[cohorly]", ...args);
  }
}
