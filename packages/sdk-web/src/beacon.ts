import { fetchTransport } from "@cohorly/core";
import type { CohorlyTransport } from "@cohorly/core";

/**
 * Best-effort transport used when the page is being unloaded/hidden. Prefers
 * navigator.sendBeacon (survives navigation/tab close) and falls back to the
 * regular fetch transport when sendBeacon is unavailable (SSR, old browsers).
 */
export const beaconTransport: CohorlyTransport = (url, body) => {
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
    const accepted = navigator.sendBeacon(url, blob);
    return accepted
      ? Promise.resolve()
      : Promise.reject(new Error("cohorly: sendBeacon was rejected by the browser"));
  }
  return fetchTransport(url, body);
};
