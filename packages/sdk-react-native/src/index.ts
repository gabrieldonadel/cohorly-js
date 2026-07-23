import { CohorlyClient } from "./client.js";
import type { CohorlyOptions, Properties } from "./types.js";

export { CohorlyClient, TransportError } from "./client.js";
export { InMemoryStorage } from "./storage.js";
export type {
  AppStateLike,
  AsyncStorageLike,
  CohorlyOptions,
  EngagePayload,
  PlatformInfo,
  Properties,
  TrackEvent,
} from "./types.js";

let sharedInstance: CohorlyClient | null = null;

/** Initializes the shared Cohorly client. Call once near app startup, e.g.:
 *
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import { init } from "@cohorly/react-native";
 *
 * init({ apiHost: "https://cohorly-service.velloalabs.com", storage: AsyncStorage });
 * ```
 */
export function init(options: CohorlyOptions): CohorlyClient {
  sharedInstance = new CohorlyClient(options);
  return sharedInstance;
}

function client(): CohorlyClient {
  if (!sharedInstance) {
    throw new Error("Cohorly: call init() before using the SDK.");
  }
  return sharedInstance;
}

export function track(event: string, properties?: Properties): void {
  client().track(event, properties);
}

export function identify(distinctId: string): void {
  client().identify(distinctId);
}

export function reset(): void {
  client().reset();
}

export function register(properties: Properties): void {
  client().register(properties);
}

export function unregister(key: string): void {
  client().unregister(key);
}

export function getDistinctId(): string {
  return client().getDistinctId();
}

export function getDeviceId(): string {
  return client().getDeviceId();
}

export function flush(): Promise<void> {
  return client().flush();
}

export function timeEvent(event: string): void {
  client().timeEvent(event);
}

export function clearTimedEvent(event: string): void {
  client().clearTimedEvent(event);
}

export function clearTimedEvents(): void {
  client().clearTimedEvents();
}

export const people = {
  set: (properties: Properties): void => client().people.set(properties),
  setOnce: (properties: Properties): void => client().people.setOnce(properties),
  increment: (properties: Properties): void => client().people.increment(properties),
  unset: (keys: string[]): void => client().people.unset(keys),
  deleteUser: (): void => client().people.deleteUser(),
};
