"use client";

import { useEffect, useState } from "react";
import { useCohorly } from "./CohorlyProvider.js";

/**
 * The current value of a feature flag: its variant key when it has one, else
 * its enabled boolean. `undefined` until flags have loaded, so callers can
 * render a stable placeholder instead of flickering from false to true.
 */
export function useFeatureFlag(key: string): boolean | string | undefined {
  const cohorly = useCohorly();
  const [value, setValue] = useState<boolean | string | undefined>(undefined);

  useEffect(() => {
    // onFeatureFlags fires immediately when flags are already loaded, and
    // again after every successful reload (identify/reset/manual).
    const unsubscribe = cohorly.onFeatureFlags(() => {
      setValue(cohorly.getFeatureFlag(key));
    });
    return unsubscribe;
  }, [cohorly, key]);

  return value;
}

/**
 * The payload of a feature flag's matched variant. `undefined` until flags
 * have loaded; `null` when the flag has no payload (or is unknown).
 */
export function useFeatureFlagPayload(key: string): unknown {
  const cohorly = useCohorly();
  const [payload, setPayload] = useState<unknown>(undefined);

  useEffect(() => {
    const unsubscribe = cohorly.onFeatureFlags(() => {
      setPayload(cohorly.getFeatureFlagPayload(key));
    });
    return unsubscribe;
  }, [cohorly, key]);

  return payload;
}
