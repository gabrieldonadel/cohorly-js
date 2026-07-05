import { CohorlyNode } from "./client.js";
import type { CohorlyConfig } from "./types.js";

export { CohorlyNode, SERVER_MAX_BATCH } from "./client.js";
export { TransportError, parseRetryAfterMs, fetchTransport } from "./transport.js";
export { LIB_VERSION } from "./version.js";
export type {
  BatchEventInput,
  Callback,
  CohorlyConfig,
  CohorlyPeople,
  CohorlyTransport,
  EngagePayload,
  Properties,
  TrackEvent,
} from "./types.js";

/**
 * Create a Cohorly client, mirroring mixpanel-node's `Mixpanel.init`:
 *
 * ```ts
 * import Cohorly from "@cohorly/node";
 * const cohorly = Cohorly.init("<project token>", { host: "http://localhost:4000" });
 * cohorly.track("signup", { distinct_id: "user-1" });
 * ```
 */
export function init(token: string, config: CohorlyConfig = {}): CohorlyNode {
  return new CohorlyNode(token, config);
}

const Cohorly = { init };
export default Cohorly;
