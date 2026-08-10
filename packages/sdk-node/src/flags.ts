import type {
  CohorlyFlags,
  FlagCallOptions,
  FlagResult,
  FlagsCallback,
} from "./types.js";

type Resolve = (
  distinctId: string,
  flagKeys?: string[],
) => Promise<Record<string, FlagResult>>;

/** Emits the `$feature_flag_called` exposure event (fire-and-forget). */
type Expose = (
  distinctId: string,
  key: string,
  response: boolean | string,
) => void;

/** Resolves `promise` into `callback` (if given) without losing the promise. */
function nodeify<T>(promise: Promise<T>, callback?: FlagsCallback<T>): Promise<T> {
  if (callback) {
    promise.then(
      (result) => callback(undefined, result),
      (err) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }
  return promise;
}

/**
 * Third argument of the flag methods is either the options object or - for
 * backwards compatibility with the callback-only signature - the callback.
 */
function args<T>(
  optionsOrCallback: FlagCallOptions | FlagsCallback<T> | undefined,
  maybeCallback: FlagsCallback<T> | undefined,
): { options: FlagCallOptions; callback: FlagsCallback<T> | undefined } {
  if (typeof optionsOrCallback === "function") {
    return { options: {}, callback: optionsOrCallback };
  }
  return { options: optionsOrCallback ?? {}, callback: maybeCallback };
}

/**
 * Builds the `flags` API on top of a resolver that already merges local
 * evaluation (ADR-0011) with the /flags/evaluate fallback, mirroring the
 * createPeople pattern. Single-key calls pass a one-key filter so the remote
 * leg, when it happens, only evaluates that flag.
 */
export function createFlags(resolve: Resolve, expose: Expose): CohorlyFlags {
  /** Runs a single-key read, emitting the exposure event when asked for. */
  function one<T>(
    key: string,
    distinctId: string,
    pick: (flag: FlagResult | undefined) => T,
    options: FlagCallOptions,
    callback: FlagsCallback<T> | undefined,
  ): Promise<T> {
    return nodeify(
      resolve(distinctId, [key]).then((flags) => {
        const flag = flags[key];
        // A flag we could not determine (unknown key) is never an exposure.
        if (options.sendExposureEvent && flag) {
          expose(distinctId, key, flag.variant ?? flag.enabled);
        }
        return pick(flag);
      }),
      callback,
    );
  }

  const isFeatureEnabled = (
    key: string,
    distinctId: string,
    optionsOrCallback?: FlagCallOptions | FlagsCallback<boolean>,
    maybeCallback?: FlagsCallback<boolean>,
  ): Promise<boolean> => {
    const { options, callback } = args(optionsOrCallback, maybeCallback);
    return one(key, distinctId, (f) => f?.enabled ?? false, options, callback);
  };

  const getFeatureFlag = (
    key: string,
    distinctId: string,
    optionsOrCallback?: FlagCallOptions | FlagsCallback<boolean | string>,
    maybeCallback?: FlagsCallback<boolean | string>,
  ): Promise<boolean | string> => {
    const { options, callback } = args(optionsOrCallback, maybeCallback);
    return one(
      key,
      distinctId,
      (f) => (f ? (f.variant ?? f.enabled) : false),
      options,
      callback,
    );
  };

  const getFeatureFlagPayload = (
    key: string,
    distinctId: string,
    optionsOrCallback?: FlagCallOptions | FlagsCallback<unknown>,
    maybeCallback?: FlagsCallback<unknown>,
  ): Promise<unknown> => {
    const { options, callback } = args(optionsOrCallback, maybeCallback);
    return one(key, distinctId, (f) => f?.payload ?? null, options, callback);
  };

  const getAllFlags = (
    distinctId: string,
    callback?: FlagsCallback<Record<string, FlagResult>>,
  ): Promise<Record<string, FlagResult>> => nodeify(resolve(distinctId), callback);

  return { isFeatureEnabled, getFeatureFlag, getFeatureFlagPayload, getAllFlags };
}
