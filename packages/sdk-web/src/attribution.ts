import type { CohorlyStorage } from "@cohorly/core";

/** localStorage key holding the persisted first-touch attribution blob (set once). */
const KEY_FIRST_TOUCH = "cohorly_first_touch";

/**
 * Campaign query params captured as super properties and (with an `initial_`
 * prefix) as first-touch profile props: UTM params, `utm_id`, and the ad-network
 * click IDs Mixpanel recognizes.
 */
export const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  // Ad click IDs.
  "dclid",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "ko_click_id",
  "li_fat_id",
  "msclkid",
  "sccid",
  "ttclid",
  "twclid",
] as const;

/** @deprecated Use `CAMPAIGN_PARAMS`. Retained as an alias for compatibility. */
export const UTM_PARAMS = CAMPAIGN_PARAMS;

const DIRECT = "$direct";

/** Search engines we recognize from the referring domain, and the query param carrying the keyword. */
const SEARCH_ENGINES: { match: RegExp; name: string; keywordParams: string[] }[] = [
  { match: /(^|\.)google\./i, name: "google", keywordParams: ["q"] },
  { match: /(^|\.)bing\./i, name: "bing", keywordParams: ["q"] },
  { match: /(^|\.)(search\.)?yahoo\./i, name: "yahoo", keywordParams: ["p"] },
  { match: /(^|\.)duckduckgo\./i, name: "duckduckgo", keywordParams: ["q"] },
];

/**
 * Parse present campaign params (UTM + ad click IDs) from a query string (e.g.
 * `location.search`). Absent params are omitted.
 */
export function parseUtm(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return out;
  }
  for (const key of CAMPAIGN_PARAMS) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/** The registrable-ish host of a URL, or `$direct` when empty/unparseable. */
export function referringDomain(url: string): string {
  if (!url) return DIRECT;
  try {
    return new URL(url).hostname || DIRECT;
  } catch {
    return DIRECT;
  }
}

/**
 * Referrer-derived props: `$referrer`, `$referring_domain`, and (when the
 * referrer is a recognized search engine) `$search_engine` + `mp_keyword`.
 * Empty referrer -> empty object (nothing to attribute this hit to).
 */
export function parseReferrer(referrer: string): Record<string, string> {
  if (!referrer) return {};
  const domain = referringDomain(referrer);
  const out: Record<string, string> = {
    $referrer: referrer,
    $referring_domain: domain,
  };
  const engine = SEARCH_ENGINES.find((e) => e.match.test(domain));
  if (engine) {
    out.$search_engine = engine.name;
    try {
      const params = new URL(referrer).searchParams;
      for (const p of engine.keywordParams) {
        const keyword = params.get(p);
        if (keyword) {
          out.mp_keyword = keyword;
          break;
        }
      }
    } catch {
      /* ignore malformed referrer URL */
    }
  }
  return out;
}

interface FirstTouch {
  $initial_referrer: string;
  $initial_referring_domain: string;
  [key: string]: string; // initial_<campaign param>
}

/** The blob is written once and never mutated, so cache the parse per storage. */
const firstTouchCache = new WeakMap<CohorlyStorage, FirstTouch>();

function readFirstTouch(storage: CohorlyStorage): FirstTouch | null {
  const cached = firstTouchCache.get(storage);
  if (cached) return cached;
  const raw = storage.get(KEY_FIRST_TOUCH);
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as FirstTouch;
    firstTouchCache.set(storage, blob);
    return blob;
  } catch {
    return null;
  }
}

/**
 * Compute + persist the first-touch attribution blob the first time we ever see
 * this browser. Returns the blob (whether newly created or previously stored)
 * and whether it was created on this call.
 */
function ensureFirstTouch(
  storage: CohorlyStorage,
  referrer: string,
  utm: Record<string, string>,
): { blob: FirstTouch; created: boolean } {
  const existing = readFirstTouch(storage);
  if (existing) return { blob: existing, created: false };
  const blob: FirstTouch = {
    $initial_referrer: referrer || DIRECT,
    $initial_referring_domain: referrer ? referringDomain(referrer) : DIRECT,
  };
  for (const key of CAMPAIGN_PARAMS) {
    if (utm[key]) blob[`initial_${key}`] = utm[key];
  }
  storage.set(KEY_FIRST_TOUCH, JSON.stringify(blob));
  firstTouchCache.set(storage, blob);
  return { blob, created: true };
}

export interface AttributionEnv {
  /** Query string (defaults to `location.search`). */
  search: string;
  /** Referrer (defaults to `document.referrer`). */
  referrer: string;
}

function currentEnv(env?: Partial<AttributionEnv>): AttributionEnv {
  const search =
    env?.search ??
    (typeof location !== "undefined" ? location.search : "");
  const referrer =
    env?.referrer ??
    (typeof document !== "undefined" ? document.referrer : "");
  return { search, referrer };
}

export interface AttributionHooks {
  /** Register session-scoped super properties (campaign params). */
  register(props: Record<string, unknown>): void;
  /** One-time first-touch profile update. */
  setOnce(props: Record<string, unknown>): void | Promise<void>;
}

/**
 * On init: register present campaign params (UTM + ad click IDs) as super props,
 * persist first-touch attribution once, and (only on first touch) emit a
 * one-time `$set_once` engage with `$initial_referrer`,
 * `$initial_referring_domain`, and `initial_<campaign param>`. Safe during SSR
 * (no-op when no storage/document).
 */
export function initAttribution(
  storage: CohorlyStorage,
  hooks: AttributionHooks,
  env?: Partial<AttributionEnv>,
): void {
  const { search, referrer } = currentEnv(env);

  const utm = parseUtm(search);
  if (Object.keys(utm).length > 0) hooks.register(utm);

  const { blob, created } = ensureFirstTouch(storage, referrer, utm);
  if (created) {
    void hooks.setOnce({ ...blob });
  }
}

/**
 * Per-event attribution default props: current referrer info plus the persisted
 * first-touch `$initial_*` props. Merged into every tracked event. Empty during
 * SSR / before init.
 */
export function getAttributionProperties(
  storage: CohorlyStorage,
  env?: Partial<AttributionEnv>,
): Record<string, unknown> {
  if (typeof document === "undefined" && !env) return {};
  const { referrer } = currentEnv(env);
  const props: Record<string, unknown> = { ...parseReferrer(referrer) };
  const firstTouch = readFirstTouch(storage);
  if (firstTouch) {
    props.$initial_referrer = firstTouch.$initial_referrer;
    props.$initial_referring_domain = firstTouch.$initial_referring_domain;
  }
  return props;
}
