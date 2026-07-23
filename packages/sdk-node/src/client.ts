import { createPeople } from "./people.js";
import { fetchTransport, TransportError } from "./transport.js";
import type {
  BatchEventInput,
  Callback,
  CohorlyConfig,
  CohorlyPeople,
  CohorlyTransport,
  EngagePayload,
  Properties,
  TrackEvent,
} from "./types.js";
import { uuid } from "./uuid.js";
import { LIB_VERSION } from "./version.js";

const DEFAULT_HOST = "https://cohorly-service.velloalabs.com";
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const BACKOFF_BASE_MS = 2000;
/** Server-side hard cap on events per /track request (400 above it). */
export const SERVER_MAX_BATCH = 500;

/** Resolves `promise` into `callback` (if given) without losing the promise. */
function nodeify(promise: Promise<void>, callback?: Callback): Promise<void> {
  if (callback) {
    promise.then(
      () => callback(),
      (err) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }
  return promise;
}

/**
 * Server-side Cohorly client, mirroring the mixpanel-node API: stateless
 * (distinct_id passed on every call, no persistent identity or storage),
 * with an in-memory batching queue for /track and immediate sends for
 * /engage and /alias. Create via `Cohorly.init(token, config)` or
 * `new CohorlyNode(token, config)`.
 */
export class CohorlyNode {
  readonly people: CohorlyPeople;

  private readonly token: string;
  private readonly host: string;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly maxQueueSize: number;
  private readonly maxRetryDelayMs: number;
  private readonly transport: CohorlyTransport;

  private queue: TrackEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  /** Serializes flushes so concurrent flush()/timer ticks never interleave. */
  private flushChain: Promise<void> = Promise.resolve();

  /** Consecutive flush failures, drives exponential backoff. Reset on success. */
  private consecutiveFailures = 0;
  /** Timestamp (ms) before which non-forced flushes are skipped. */
  private backoffUntil = 0;
  /** Current effective per-flush batch size; halved on 413 (floor 1). */
  private effectiveBatchSize: number;

  constructor(token: string, config: CohorlyConfig = {}) {
    if (!token || typeof token !== "string") {
      throw new TypeError("cohorly: a project token is required");
    }
    this.token = token;
    this.host = (config.host ?? DEFAULT_HOST).replace(/\/$/, "");
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.batchSize = Math.max(
      1,
      Math.min(config.batchSize ?? DEFAULT_BATCH_SIZE, SERVER_MAX_BATCH),
    );
    this.debug = config.debug ?? false;
    this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.transport = config.transport ?? fetchTransport;
    this.effectiveBatchSize = this.batchSize;

    this.people = createPeople((payload, callback) =>
      this.sendEngage(payload, callback),
    );

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.enqueueFlush(false).catch((err) =>
          this.log("auto-flush failed", err),
        );
      }, this.flushIntervalMs);
      // Don't keep the Node process alive just for the flush timer.
      const timer = this.flushTimer as { unref?: () => void };
      timer.unref?.();
    }
  }

  /**
   * Queue an event for delivery. `properties.distinct_id` is required
   * (server-side style, like mixpanel-node). Default properties are stamped:
   * `time` (unix ms, now) and `$insert_id` (uuid) unless supplied by the
   * caller, plus `$lib` = "node" and `$lib_version`.
   *
   * The callback/promise settles when the event is accepted into the queue;
   * delivery happens asynchronously in batches (size trigger + interval).
   */
  track(
    event: string,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    return nodeify(
      Promise.resolve().then(() => this.enqueue([this.buildEvent(event, properties)])),
      callback,
    );
  }

  /** Queue multiple events at once (mixpanel-node `track_batch`). */
  trackBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return nodeify(
      Promise.resolve().then(() =>
        this.enqueue(events.map((e) => this.buildEvent(e.event, e.properties))),
      ),
      callback,
    );
  }

  /** mixpanel-node-style alias for {@link trackBatch}. */
  track_batch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.trackBatch(events, callback);
  }

  /**
   * Track a historical event with an explicit timestamp (mixpanel-node
   * `import`). `time` is a Date or unix ms. Cohorly's /track accepts any
   * `time`, so this queues through the same pipeline as {@link track}.
   */
  import(
    event: string,
    time: Date | number,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    const ms = time instanceof Date ? time.getTime() : time;
    return this.track(event, { ...properties, time: ms }, callback);
  }

  /** Batch form of {@link import}: events must carry `properties.time`. */
  importBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.trackBatch(events, callback);
  }

  /** mixpanel-node-style alias for {@link importBatch}. */
  import_batch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.importBatch(events, callback);
  }

  /**
   * Create an alias for a distinct id (POST /alias). Sent immediately, not
   * queued; the promise/callback settles with the server response.
   */
  alias(distinctId: string, alias: string, callback?: Callback): Promise<void> {
    return nodeify(
      this.transport(
        `${this.host}/alias`,
        { alias, distinct_id: distinctId },
        this.headers(),
      ),
      callback,
    );
  }

  /**
   * Force-flush the queue now, draining it in <=500-event requests. Runs even
   * during retry backoff (an explicit "try now"). Rejects with the transport
   * error if the queue could not be fully drained (events are kept for retry
   * per the retry contract).
   */
  flush(callback?: Callback): Promise<void> {
    return nodeify(this.enqueueFlush(true), callback);
  }

  /**
   * Stop the auto-flush timer and attempt a final flush. Never rejects -
   * a failed final flush is logged (debug) and remaining events are dropped
   * with the process. Call this on graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      await this.enqueueFlush(true);
    } catch (err) {
      this.log("final flush on shutdown failed", err);
    }
  }

  /** Number of events currently queued (mainly for tests/monitoring). */
  get queueSize(): number {
    return this.queue.length;
  }

  private buildEvent(
    event: string,
    properties: Properties & { distinct_id: string },
  ): TrackEvent {
    if (!event || typeof event !== "string") {
      throw new TypeError("cohorly: event name is required");
    }
    const distinctId = properties?.distinct_id;
    if (typeof distinctId !== "string" || distinctId.length === 0) {
      throw new TypeError(
        `cohorly: properties.distinct_id is required to track "${event}"`,
      );
    }
    return {
      event,
      properties: {
        ...properties,
        distinct_id: distinctId,
        time: typeof properties.time === "number" ? properties.time : Date.now(),
        $insert_id:
          typeof properties.$insert_id === "string"
            ? properties.$insert_id
            : uuid(),
        $lib: "node",
        $lib_version: LIB_VERSION,
      },
    };
  }

  private enqueue(events: TrackEvent[]): void {
    this.queue.push(...events);
    if (this.queue.length > this.maxQueueSize) {
      const overflow = this.queue.length - this.maxQueueSize;
      this.queue.splice(0, overflow);
      this.log("queue cap exceeded, dropped oldest events", overflow);
    }
    if (this.queue.length >= this.batchSize) {
      this.enqueueFlush(false).catch((err) =>
        this.log("size-triggered flush failed", err),
      );
    }
  }

  /** Chains a flush behind any in-flight one so flushes never interleave. */
  private enqueueFlush(force: boolean): Promise<void> {
    const run = this.flushChain
      .catch(() => undefined)
      .then(() => this.runFlush(force));
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async runFlush(force: boolean): Promise<void> {
    let lastError: unknown;
    while (this.queue.length > 0) {
      if (!force && Date.now() < this.backoffUntil) return;
      const size = Math.max(
        1,
        Math.min(this.effectiveBatchSize, SERVER_MAX_BATCH),
      );
      const batch = this.queue.slice(0, size);
      try {
        await this.transport(`${this.host}/track`, batch, this.headers());
        this.queue = this.queue.slice(batch.length);
        // Success: clear failure state and backoff.
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        const disposition = this.handleFlushError(err, batch.length);
        if (disposition === "dropped") continue; // 400: batch removed, keep draining
        if (disposition === "halved" && batch.length > 1) continue; // retry smaller now
        lastError = err;
        break;
      }
    }
    if (force && lastError !== undefined) throw lastError;
  }

  /**
   * Applies the retry contract to a failed flush. `batchLen` is how many
   * events were in the just-attempted batch (front of the queue).
   *
   * - 400: payload permanently rejected - drop that batch, do not retry it.
   * - 413: payload too big - halve the effective batch size (floor 1), keep
   *   the queue, retry smaller (no backoff).
   * - 401: invalid token - keep queue, warn, backoff at max delay.
   * - 429 / 5xx / network: keep queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(
    err: unknown,
    batchLen: number,
  ): "dropped" | "halved" | "backoff" {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      this.log("dropping batch permanently rejected with 400", err);
      this.queue = this.queue.slice(batchLen);
      return "dropped";
    }

    if (status === 413) {
      this.effectiveBatchSize = Math.max(
        1,
        Math.floor(this.effectiveBatchSize / 2),
      );
      this.log(
        "payload too large (413), halving batch size to",
        this.effectiveBatchSize,
      );
      // Keep queue intact; retry with the smaller batch.
      return "halved";
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
    return "backoff";
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
   * Send a profile op to /engage immediately (not queued). The promise or
   * callback settles with the server response; failed engage ops are NOT
   * retried (matching the other Cohorly SDKs).
   */
  private sendEngage(payload: EngagePayload, callback?: Callback): Promise<void> {
    return nodeify(
      Promise.resolve().then(() => {
        if (!payload.distinct_id || typeof payload.distinct_id !== "string") {
          throw new TypeError(
            "cohorly: distinct_id is required for profile updates",
          );
        }
        return this.transport(`${this.host}/engage`, payload, this.headers());
      }),
      callback,
    );
  }

  private headers(): Record<string, string> {
    return { "X-Cohorly-Token": this.token };
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.warn("[cohorly]", ...args);
  }
}
