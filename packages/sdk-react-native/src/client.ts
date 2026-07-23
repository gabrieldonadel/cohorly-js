import {
  deriveDeviceInfo,
  fetchNativeDeviceInfo,
  loadNativeModules,
  mergePlatformInfo,
  resolveAppState,
  watchWifi,
} from "./deviceInfo.js";
import { InMemoryStorage } from "./storage.js";
import type {
  AppStateLike,
  AsyncStorageLike,
  CohorlyOptions,
  EngagePayload,
  PlatformInfo,
  Properties,
  TrackEvent,
} from "./types.js";
import { uuid } from "./uuid.js";
import { LIB_VERSION } from "./version.js";

const KEYS = {
  distinctId: "cohorly:distinct_id",
  deviceId: "cohorly:device_id",
  anonymous: "cohorly:anonymous",
  superProps: "cohorly:super_properties",
  queue: "cohorly:queue",
  engageQueue: "cohorly:engage_queue",
  aeFirstOpen: "cohorly:ae_first_open",
  aeLastVersion: "cohorly:ae_last_version",
} as const;

const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_FLUSH_AT = 20;
const LIB_NAME = "react-native";
/** Cohorly's hosted ingestion API. Used when no apiHost is supplied. */
const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";

const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const BACKOFF_BASE_MS = 2000;
/** Minimum foreground duration (seconds) before an `$ae_session` event fires. */
const MIN_SESSION_LENGTH_SEC = 10;

/**
 * Error thrown by `send()` on a non-OK HTTP response, carrying the HTTP status
 * and (when the server sent one) the parsed `Retry-After` in ms. Copied here
 * to keep this package standalone (see repo CLAUDE.md "Ownership" convention).
 * Network failures reject with the underlying fetch error, not a TransportError.
 */
export class TransportError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, retryAfterMs?: number) {
    super(`Cohorly: request failed with status ${status}`);
    this.name = "TransportError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** Subscribes a single `change` listener on the given AppState-like object.
 * Guarded so a missing/broken AppState never throws. */
function watchAppState(appState: AppStateLike | undefined, onChange: (state: string) => void): void {
  try {
    appState?.addEventListener?.("change", onChange);
  } catch {
    // Broken/incompatible AppState implementation - no-op, fully optional.
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
  private maxQueueSize: number;
  private maxRetryDelayMs: number;
  private appVersion: string | undefined;
  private appBuild: string | undefined;
  private trackAutomaticEvents: boolean;
  private platformInfo: PlatformInfo;
  private wifi: boolean | undefined;
  private appStateModule: AppStateLike | undefined;

  private distinctId: string;
  /**
   * Stable per-device id stamped as `$device_id` on every event (Mixpanel
   * parity). Persisted separately from the distinct id so it survives
   * identify(); reset() mints a new one. On a fresh (anonymous) install it
   * equals the anon distinct id; an older identified install migrating in
   * mints a fresh uuid.
   */
  private deviceId: string;
  /** True until identify() is called (or after reset()). Drives `$user_id`
   * stamping - the reserved `$user_id` is only attached once identified. */
  private anonymous = true;
  private superProps: Properties = {};
  private queue: TrackEvent[] = [];
  private engageQueue: EngagePayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** In-memory start timestamps (ms) for timed events, keyed by event name.
   * The next `track()` of the same name attaches `$duration` (seconds) and
   * clears the entry. Not persisted - mirrors Mixpanel's `time_event`. */
  private timedEvents = new Map<string, number>();

  /** Consecutive flush failures, drives exponential backoff. Reset on success. */
  private consecutiveFailures = 0;
  /** Timestamp (ms) before which non-forced flushes are skipped. */
  private backoffUntil = 0;
  /** Current effective per-flush batch size; halved on 413 (floor 1). */
  private effectiveBatchSize: number;

  /** Last-seen AppState status, used to detect active<->background edges. */
  private appStateStatus = "active";
  /** Timestamp (ms) the app most recently became active/foregrounded. */
  private sessionStartedAt = Date.now();

  /** Resolves once persisted state (distinct id, super props, queued events)
   * has been loaded from storage. Tests can await this for determinism. */
  readonly ready: Promise<void>;
  /** True once hydrate() has loaded the persisted distinct_id/queues. */
  private hydrated = false;

  constructor(options: CohorlyOptions) {
    this.apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
    this.storage = options.storage ?? new InMemoryStorage();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
    this.disabled = options.disabled ?? false;
    this.token = options.token;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.trackAutomaticEvents = options.trackAutomaticEvents ?? false;
    this.effectiveBatchSize = this.flushAt;
    this.distinctId = uuid();
    // Transient until hydrate() resolves the persisted/derived value.
    this.deviceId = this.distinctId;

    const mods = loadNativeModules();
    const derived = deriveDeviceInfo(mods);
    this.appVersion = options.appVersion ?? derived.appVersion;
    this.appBuild = options.appBuild ?? derived.appBuild;
    this.platformInfo = mergePlatformInfo(derived.platformInfo, options.platformInfo);
    this.wifi = this.platformInfo.wifi;
    if (this.wifi === undefined) {
      watchWifi(mods.netInfo, (w) => {
        this.wifi = w;
      });
    }
    this.appStateModule = resolveAppState(options.appState, mods.rn);

    // Highest-precedence auto-derived tier: this package's own autolinked
    // native module (when the host app has rebuilt with it linked). Resolves
    // async, so it's folded into `ready` - explicit options still win over it,
    // and it wins over the react-native-device-info/expo sync tiers above.
    const nativeReady = fetchNativeDeviceInfo(mods.rn).then((native) => {
      this.appVersion = options.appVersion ?? native.appVersion ?? derived.appVersion;
      this.appBuild = options.appBuild ?? native.appBuild ?? derived.appBuild;
      const withNative = mergePlatformInfo(derived.platformInfo, native.platformInfo);
      this.platformInfo = mergePlatformInfo(withNative, options.platformInfo);
      if (this.platformInfo.wifi !== undefined) this.wifi = this.platformInfo.wifi;
    });

    this.ready = Promise.all([this.hydrate(), nativeReady]).then(() => undefined);
    this.startTimer();
    watchAppState(this.appStateModule, (state) => this.handleAppStateChange(state));
  }

  /** Merges device/app default properties into every tracked event, on top
   * of super props and below explicit per-call properties (see `track()`). */
  private getDeviceDefaultProperties(): Properties {
    const props: Properties = { $lib_version: LIB_VERSION };
    const p = this.platformInfo;
    if (p.os !== undefined) props.$os = p.os;
    if (p.osVersion !== undefined) props.$os_version = p.osVersion;
    if (p.screenHeight !== undefined) props.$screen_height = p.screenHeight;
    if (p.screenWidth !== undefined) props.$screen_width = p.screenWidth;
    if (p.model !== undefined) props.$model = p.model;
    if (p.manufacturer !== undefined) props.$manufacturer = p.manufacturer;
    if (p.brand !== undefined) props.$brand = p.brand;
    if (p.carrier !== undefined) props.$carrier = p.carrier;
    if (this.wifi !== undefined) props.$wifi = this.wifi;
    if (this.appVersion !== undefined) props.$app_version_string = this.appVersion;
    if (this.appBuild !== undefined) props.$app_build_number = this.appBuild;
    return props;
  }

  /** Default profile properties merged into every `people.set`/`people.setOnce`
   * call (Mixpanel Native Mode parity). Platform-scoped by `Platform.OS`: the
   * `$android_*` set on Android, the `$ios_*` set on iOS. User-supplied keys
   * always win (never overridden). Keys whose source value can't be derived in
   * the current environment are simply omitted. */
  private getProfileDefaultProperties(): Properties {
    const p = this.platformInfo;
    const props: Properties = {};
    if (p.os === "Android") {
      props.$android_lib_version = LIB_VERSION;
      props.$android_os = "Android";
      if (p.osVersion !== undefined) props.$android_os_version = String(p.osVersion);
      if (this.appVersion !== undefined) props.$android_app_version = this.appVersion;
      if (p.model !== undefined) props.$android_model = p.model;
      if (p.manufacturer !== undefined) props.$android_manufacturer = p.manufacturer;
      if (p.brand !== undefined) props.$android_brand = p.brand;
    } else if (p.os === "iOS") {
      props.$ios_lib_version = LIB_VERSION;
      if (p.osVersion !== undefined) props.$ios_version = String(p.osVersion);
      if (this.appVersion !== undefined) props.$ios_app_release = this.appVersion;
      if (this.appBuild !== undefined) props.$ios_app_version = this.appBuild;
      if (p.model !== undefined) props.$ios_device_model = p.model;
    }
    return props;
  }

  /** Single AppState "change" handler: keeps the existing flush-on-background
   * behavior and, when `trackAutomaticEvents` is on, tracks `$ae_session` on
   * the active -> background/inactive edge. Never adds a second listener. */
  private handleAppStateChange(state: string): void {
    const wasActive = this.appStateStatus === "active";
    const isBackground = state === "background" || state === "inactive";

    if (isBackground) {
      // Queue the session event (if any) before flushing, so a single
      // background-triggered flush delivers it in the same batch. If storage
      // hydration is still pending (cold-launch background), defer so the
      // persisted distinct_id, not the transient constructor uuid, is attached.
      const shouldTrack = this.trackAutomaticEvents && wasActive;
      const lengthSec = shouldTrack
        ? Math.round((Date.now() - this.sessionStartedAt) / 1000)
        : 0;
      const finish = () => {
        if (shouldTrack && lengthSec >= MIN_SESSION_LENGTH_SEC) {
          this.track("$ae_session", { $ae_session_length: lengthSec });
          this.people.increment({
            $ae_total_app_sessions: 1,
            $ae_total_app_session_length: lengthSec,
          });
        }
        this.maybeFlush();
      };
      if (this.hydrated) finish();
      else void this.ready.then(finish);
    } else if (state === "active" && !wasActive) {
      this.sessionStartedAt = Date.now();
    }

    this.appStateStatus = state;
  }

  /** Fires `$ae_first_open` (once ever) and `$ae_updated` (on appVersion
   * change) when `trackAutomaticEvents` is enabled. Called once storage is
   * hydrated so the persisted flags/last-seen version are available. */
  private async trackAutomaticLifecycleEvents(): Promise<void> {
    if (!this.trackAutomaticEvents) return;

    const firstOpenFlag = await this.storage.getItem(KEYS.aeFirstOpen);
    if (!firstOpenFlag) {
      await this.storage.setItem(KEYS.aeFirstOpen, "1");
      this.track("$ae_first_open");
      this.people.setOnce({ $ae_first_app_open_date: new Date().toISOString() });
    }

    if (this.appVersion !== undefined) {
      const lastVersion = await this.storage.getItem(KEYS.aeLastVersion);
      if (lastVersion !== null && lastVersion !== this.appVersion) {
        this.track("$ae_updated", { $ae_updated_version: this.appVersion });
      }
      if (lastVersion !== this.appVersion) {
        await this.storage.setItem(KEYS.aeLastVersion, this.appVersion);
      }
    }
  }

  private async hydrate(): Promise<void> {
    const [storedId, storedAnon, storedDevice, storedSuper, storedQueue, storedEngageQueue] =
      await Promise.all([
        this.storage.getItem(KEYS.distinctId),
        this.storage.getItem(KEYS.anonymous),
        this.storage.getItem(KEYS.deviceId),
        this.storage.getItem(KEYS.superProps),
        this.storage.getItem(KEYS.queue),
        this.storage.getItem(KEYS.engageQueue),
      ]);

    if (storedId) {
      this.distinctId = storedId;
      // Installs predating the anonymous flag have no stored value; treat them
      // as anonymous rather than stamping a possibly-false $user_id. Identified
      // users self-heal on their next identify() call.
      this.anonymous = storedAnon !== "0";
    } else {
      this.anonymous = true;
      await this.storage.setItem(KEYS.distinctId, this.distinctId);
      await this.storage.setItem(KEYS.anonymous, "1");
    }

    // Device id: persisted separately so it survives identify(). A fresh or
    // migrating anonymous install reuses the anon distinct id (Mixpanel's
    // `$device:<uuid>` convention); an identified install (anonymous flag "0")
    // mints a fresh one.
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      this.deviceId = this.anonymous ? this.distinctId : uuid();
      await this.storage.setItem(KEYS.deviceId, this.deviceId);
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
      // Enforce the persisted cap on load in case a larger queue was stored.
      if (this.enforceQueueCap()) this.persistQueue();
    }
    if (storedEngageQueue) {
      try {
        this.engageQueue = JSON.parse(storedEngageQueue);
      } catch {
        this.engageQueue = [];
      }
    }

    await this.trackAutomaticLifecycleEvents();
    this.hydrated = true;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.maybeFlush();
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

  /** Stable per-device id stamped as `$device_id` on every event. Survives
   * identify(); reset() mints a new one. */
  getDeviceId(): string {
    return this.deviceId;
  }

  register(properties: Properties): void {
    this.superProps = { ...this.superProps, ...properties };
    this.persistSuperProps();
  }

  unregister(key: string): void {
    delete this.superProps[key];
    this.persistSuperProps();
  }

  /** Starts an in-memory timer for `event`. The next `track(event)` of the same
   * name attaches `$duration` (seconds, 3 decimals) and clears the timer.
   * Mirrors Mixpanel's `time_event`. */
  timeEvent(event: string): void {
    this.timedEvents.set(event, Date.now());
  }

  /** Cancels a pending timer started by `timeEvent(event)` without tracking. */
  clearTimedEvent(event: string): void {
    this.timedEvents.delete(event);
  }

  /** Cancels all pending timed-event timers. */
  clearTimedEvents(): void {
    this.timedEvents.clear();
  }

  /** Computes `$duration` (seconds, 3 decimals) for a timed event and clears
   * its timer, returning `{}` when the event was not timed. */
  private consumeTimedEvent(event: string): Properties {
    const startedAt = this.timedEvents.get(event);
    if (startedAt === undefined) return {};
    this.timedEvents.delete(event);
    const durationSec = Math.round(((Date.now() - startedAt) / 1000) * 1000) / 1000;
    return { $duration: durationSec };
  }

  track(event: string, properties: Properties = {}): void {
    const props: TrackEvent["properties"] = {
      ...this.getDeviceDefaultProperties(),
      ...this.consumeTimedEvent(event),
      ...this.superProps,
      ...properties,
      distinct_id: this.distinctId,
      time: Date.now(),
      $insert_id: uuid(),
      $lib: LIB_NAME,
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    // Reserved identity fields, stamped last but never overriding a value the
    // caller passed explicitly (mirrors Mixpanel's $device_id/$user_id).
    if (props.$device_id === undefined) props.$device_id = this.deviceId;
    if (!this.anonymous && props.$user_id === undefined) {
      props.$user_id = this.distinctId;
    }
    const payload: TrackEvent = { event, properties: props };
    this.queue.push(payload);
    this.enforceQueueCap();
    this.persistQueue();
    if (this.queue.length >= this.flushAt) {
      this.maybeFlush();
    }
  }

  identify(distinctId: string): void {
    this.distinctId = distinctId;
    this.anonymous = false;
    void this.storage.setItem(KEYS.distinctId, distinctId);
    void this.storage.setItem(KEYS.anonymous, "0");
  }

  /** Clears identity, super properties, queued-but-unsent events, and any
   * pending timed events, then assigns a fresh anonymous distinct id (and a
   * matching new device id). Mirrors mixpanel's `reset()`. */
  reset(): void {
    this.distinctId = uuid();
    // New anon identity: the device id follows the fresh anon distinct id.
    this.deviceId = this.distinctId;
    this.anonymous = true;
    this.superProps = {};
    this.queue = [];
    this.engageQueue = [];
    this.timedEvents.clear();
    void this.storage.setItem(KEYS.distinctId, this.distinctId);
    void this.storage.setItem(KEYS.deviceId, this.deviceId);
    void this.storage.setItem(KEYS.anonymous, "1");
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
      this.maybeFlush();
    }
  }

  readonly people = {
    set: (properties: Properties): void => {
      this.queueEngage({
        distinct_id: this.distinctId,
        $set: { ...this.getProfileDefaultProperties(), ...properties },
      });
    },
    setOnce: (properties: Properties): void => {
      this.queueEngage({
        distinct_id: this.distinctId,
        $set_once: { ...this.getProfileDefaultProperties(), ...properties },
      });
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
   * callers await that same in-flight operation instead of racing it.
   *
   * A manual `flush()` always attempts a send, even while in backoff (treated
   * as an explicit "try now"). The auto-flush timer, size triggers, and
   * app-state transitions go through the backoff-aware path and are skipped
   * until the backoff deadline passes. */
  async flush(): Promise<void> {
    return this.runFlush(true);
  }

  /** Backoff-aware flush used by the timer, size triggers, and app-state. */
  private maybeFlush(): void {
    void this.runFlush(false);
  }

  private runFlush(force: boolean): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.flushPromise = this.doFlush(force).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async doFlush(force: boolean): Promise<void> {
    if (this.disabled) return;
    if (!force && Date.now() < this.backoffUntil) return;

    if (this.queue.length > 0) {
      const size = Math.max(1, this.effectiveBatchSize);
      const batch = this.queue.slice(0, size);
      this.queue = this.queue.slice(batch.length);
      this.persistQueue();
      try {
        await this.send("/track", batch);
        // Success: clear failure state and backoff.
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        this.handleFlushError(err, batch);
        return; // stop; don't attempt engage while backing off.
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

  /**
   * Applies the retry contract to a failed /track flush. `batch` is the just-
   * attempted set of events (already removed from the front of the queue).
   *
   * - 400: payload permanently rejected - drop that batch, do not re-queue.
   * - 413: too big - re-queue and halve the effective batch size (no backoff).
   * - 401: invalid token - re-queue, backoff at max delay.
   * - 429 / 5xx / network: re-queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(err: unknown, batch: TrackEvent[]): void {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      // Permanently rejected: already removed from the queue, so just drop.
      return;
    }

    // Re-queue at the front for the next attempt.
    this.queue = [...batch, ...this.queue];
    this.persistQueue();

    if (status === 413) {
      this.effectiveBatchSize = Math.max(1, Math.floor(this.effectiveBatchSize / 2));
      return;
    }

    this.consecutiveFailures += 1;
    let delay = this.computeBackoffMs();
    if (status === 401) {
      delay = this.maxRetryDelayMs;
    } else if (
      status === 429 &&
      err instanceof TransportError &&
      err.retryAfterMs !== undefined
    ) {
      delay = Math.min(err.retryAfterMs, this.maxRetryDelayMs);
    }
    this.backoffUntil = Date.now() + delay;
  }

  /** Exponential backoff: base 2000ms, doubling per failure, capped, +/-20% jitter. */
  private computeBackoffMs(): number {
    const exp = BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1);
    const capped = Math.min(exp, this.maxRetryDelayMs);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  /** Trims the queue to `maxQueueSize`, dropping the OLDEST events. */
  private enforceQueueCap(): boolean {
    if (this.queue.length <= this.maxQueueSize) return false;
    const overflow = this.queue.length - this.maxQueueSize;
    this.queue.splice(0, overflow);
    return true;
  }

  private async send(path: string, body: unknown): Promise<void> {
    if (!this.fetchImpl) return;
    const res = await this.fetchImpl(`${this.apiHost}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new TransportError(
        res.status,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
  }
}
