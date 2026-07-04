import { InMemoryStorage } from "./storage.js";
import { uuid } from "./uuid.js";
import type {
  AsyncStorageLike,
  CohorlyOptions,
  EngagePayload,
  Properties,
  TrackEvent,
} from "./types.js";

const KEYS = {
  distinctId: "cohorly:distinct_id",
  superProps: "cohorly:super_properties",
  queue: "cohorly:queue",
  engageQueue: "cohorly:engage_queue",
} as const;

const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_FLUSH_AT = 20;
const LIB_NAME = "react-native";

// Metro/Hermes expose a global `require` even though this package is
// authored and compiled as ESM; plain Node/browser environments won't have
// it, so every use below is guarded by try/catch and an existence check.
declare const require: ((id: string) => any) | undefined;

/** Best-effort optional require of `react-native`'s AppState so we can flush
 * on background/foreground transitions. Guarded so this package never throws
 * or fails to load outside a React Native environment (e.g. plain Node/Jest,
 * or when react-native isn't installed at all). */
function tryWatchAppState(onBackground: () => void): void {
  try {
    if (typeof require !== "function") return;
    const rn = require("react-native");
    const AppState = rn?.AppState;
    if (AppState?.addEventListener) {
      AppState.addEventListener("change", (state: string) => {
        if (state === "background" || state === "inactive") {
          onBackground();
        }
      });
    }
  } catch {
    // react-native not present - no-op, fully optional.
  }
}

export class CohorlyClient {
  private apiHost: string;
  private storage: AsyncStorageLike;
  private fetchImpl: typeof fetch;
  private flushInterval: number;
  private flushAt: number;
  private disabled: boolean;
  private token: string | undefined;

  private distinctId: string;
  private superProps: Properties = {};
  private queue: TrackEvent[] = [];
  private engageQueue: EngagePayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Resolves once persisted state (distinct id, super props, queued events)
   * has been loaded from storage. Tests can await this for determinism. */
  readonly ready: Promise<void>;

  constructor(options: CohorlyOptions) {
    this.apiHost = options.apiHost.replace(/\/$/, "");
    this.storage = options.storage ?? new InMemoryStorage();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
    this.disabled = options.disabled ?? false;
    this.token = options.token;
    this.distinctId = uuid();

    this.ready = this.hydrate();
    this.startTimer();
    tryWatchAppState(() => {
      void this.flush();
    });
  }

  private async hydrate(): Promise<void> {
    const [storedId, storedSuper, storedQueue, storedEngageQueue] = await Promise.all([
      this.storage.getItem(KEYS.distinctId),
      this.storage.getItem(KEYS.superProps),
      this.storage.getItem(KEYS.queue),
      this.storage.getItem(KEYS.engageQueue),
    ]);

    if (storedId) {
      this.distinctId = storedId;
    } else {
      await this.storage.setItem(KEYS.distinctId, this.distinctId);
    }
    if (storedSuper) {
      try {
        this.superProps = JSON.parse(storedSuper);
      } catch {
        this.superProps = {};
      }
    }
    if (storedQueue) {
      try {
        this.queue = JSON.parse(storedQueue);
      } catch {
        this.queue = [];
      }
    }
    if (storedEngageQueue) {
      try {
        this.engageQueue = JSON.parse(storedEngageQueue);
      } catch {
        this.engageQueue = [];
      }
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
    // Don't keep the Node/Hermes process alive purely for this timer.
    const t = this.timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  /** Stops the auto-flush timer. Useful for tests and clean shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private persistQueue(): void {
    void this.storage.setItem(KEYS.queue, JSON.stringify(this.queue));
  }

  private persistEngageQueue(): void {
    void this.storage.setItem(KEYS.engageQueue, JSON.stringify(this.engageQueue));
  }

  private persistSuperProps(): void {
    void this.storage.setItem(KEYS.superProps, JSON.stringify(this.superProps));
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  register(properties: Properties): void {
    this.superProps = { ...this.superProps, ...properties };
    this.persistSuperProps();
  }

  unregister(key: string): void {
    delete this.superProps[key];
    this.persistSuperProps();
  }

  track(event: string, properties: Properties = {}): void {
    const payload: TrackEvent = {
      event,
      properties: {
        ...this.superProps,
        ...properties,
        distinct_id: this.distinctId,
        time: Date.now(),
        $insert_id: uuid(),
        $lib: LIB_NAME,
        ...(this.token !== undefined ? { token: this.token } : {}),
      },
    };
    this.queue.push(payload);
    this.persistQueue();
    if (this.queue.length >= this.flushAt) {
      void this.flush();
    }
  }

  identify(distinctId: string): void {
    this.distinctId = distinctId;
    void this.storage.setItem(KEYS.distinctId, distinctId);
  }

  /** Clears identity, super properties, and queued-but-unsent events, then
   * assigns a fresh anonymous distinct id. Mirrors mixpanel's `reset()`. */
  reset(): void {
    this.distinctId = uuid();
    this.superProps = {};
    this.queue = [];
    this.engageQueue = [];
    void this.storage.setItem(KEYS.distinctId, this.distinctId);
    this.persistSuperProps();
    this.persistQueue();
    this.persistEngageQueue();
  }

  private queueEngage(payload: EngagePayload): void {
    this.engageQueue.push(
      this.token !== undefined ? { ...payload, token: this.token } : payload,
    );
    this.persistEngageQueue();
    if (this.engageQueue.length >= this.flushAt) {
      void this.flush();
    }
  }

  readonly people = {
    set: (properties: Properties): void => {
      this.queueEngage({ distinct_id: this.distinctId, $set: properties });
    },
    setOnce: (properties: Properties): void => {
      this.queueEngage({ distinct_id: this.distinctId, $set_once: properties });
    },
    increment: (properties: Properties): void => {
      this.queueEngage({ distinct_id: this.distinctId, $add: properties });
    },
    unset: (keys: string[]): void => {
      this.queueEngage({ distinct_id: this.distinctId, $unset: keys });
    },
    deleteUser: (): void => {
      this.queueEngage({ distinct_id: this.distinctId, $delete: true });
    },
  };

  private flushPromise: Promise<void> | null = null;

  /** Flushes queued events/engage payloads. Safe to call concurrently: if a
   * flush is already in flight (e.g. triggered automatically by `track()`
   * reaching `flushAt` while a caller also calls `flush()` manually), later
   * callers await that same in-flight operation instead of racing it. */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.flushPromise = this.doFlush().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    if (this.disabled) return;

    if (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = [];
      this.persistQueue();
      try {
        await this.send("/track", batch);
      } catch {
        // Put events back at the front of the queue for the next attempt.
        this.queue = [...batch, ...this.queue];
        this.persistQueue();
      }
    }

    if (this.engageQueue.length > 0) {
      const batch = this.engageQueue;
      this.engageQueue = [];
      this.persistEngageQueue();
      try {
        await this.send("/engage", batch);
      } catch {
        this.engageQueue = [...batch, ...this.engageQueue];
        this.persistEngageQueue();
      }
    }
  }

  private async send(path: string, body: unknown): Promise<void> {
    if (!this.fetchImpl) return;
    const res = await this.fetchImpl(`${this.apiHost}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Cohorly: request to ${path} failed with status ${res.status}`);
    }
  }
}
