import { uuid } from "./uuid.js";
import { fetchTransport } from "./transport.js";
import type {
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  PeopleProperties,
  TrackedEvent,
} from "./types.js";

const KEY_DISTINCT_ID = "cohorly_distinct_id";
const KEY_ANONYMOUS = "cohorly_anonymous";
const KEY_SUPER_PROPS = "cohorly_super_props";
const KEY_QUEUE = "cohorly_queue";

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

  private distinctId: string;
  private anonymous: boolean;
  private superProps: Record<string, unknown>;
  private queue: TrackedEvent[];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  readonly people: PeopleProperties;

  constructor(options: CohorlyClientOptions) {
    this.apiHost = options.apiHost.replace(/\/$/, "");
    this.storage = options.storage;
    this.transport = options.transport ?? fetchTransport;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 20;
    this.debug = options.debug ?? false;
    this.lib = options.lib ?? "core";
    this.token = options.token;

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

    this.superProps = this.readJson(KEY_SUPER_PROPS, {});
    this.queue = this.readJson(KEY_QUEUE, []);

    this.people = {
      set: (props) => this.sendEngage({ $set: props }),
      setOnce: (props) => this.sendEngage({ $set_once: props }),
      increment: (props) => this.sendEngage({ $add: props }),
      unset: (keys) => this.sendEngage({ $unset: keys }),
      delete: () => this.sendEngage({ $delete: true }),
    };

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => this.log("auto-flush failed", err));
      }, this.flushIntervalMs);
      // Don't keep the Node process alive just for the flush timer.
      const timer = this.flushTimer as { unref?: () => void };
      timer.unref?.();
    }
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  isAnonymous(): boolean {
    return this.anonymous;
  }

  track(event: string, properties: Record<string, unknown> = {}): TrackedEvent {
    const evt: TrackedEvent = {
      event,
      properties: {
        ...this.superProps,
        ...properties,
        distinct_id: this.distinctId,
        time: Date.now(),
        $insert_id: uuid(),
        $lib: this.lib,
        ...(this.token !== undefined ? { token: this.token } : {}),
      },
    };
    this.queue.push(evt);
    this.persistQueue();
    if (this.queue.length >= this.batchSize) {
      this.flush().catch((err) => this.log("flush failed", err));
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
    this.anonymous = true;
    this.storage.set(KEY_DISTINCT_ID, this.distinctId);
    this.storage.set(KEY_ANONYMOUS, "1");
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

  async flush(transportOverride?: CohorlyTransport): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.queue.slice(0, this.batchSize);
      const send = transportOverride ?? this.transport;
      try {
        await send(`${this.apiHost}/track`, batch);
        this.queue = this.queue.slice(batch.length);
        this.persistQueue();
      } catch (err) {
        // Network/server error: keep events queued for the next attempt.
        this.log("flush request failed, keeping queue", err);
      }
    } finally {
      this.flushing = false;
    }
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
