import { createHash } from "node:crypto";
import type { FlagDefinition, FlagResult, FlagVariant } from "./types.js";

/**
 * Local flag evaluation (ADR-0011). This is a deliberate re-implementation of
 * the server's evaluator (`apps/server/src/store.ts`) rather than an import -
 * SDK packages stay standalone (repo CLAUDE.md "Ownership"). The hash must
 * stay byte-identical to the server's: any change here is a bucketing change
 * for every user of every flag.
 *
 * Two documented divergences from the server, both from ADR-0011:
 * - we hash the RAW distinct_id (no identity-cluster resolution is possible
 *   in-process), so Override lists are matched on the raw id only;
 * - a flag whose rules reference a Cohort is `localEvaluable: false` and must
 *   never reach this module - the caller falls back to /flags/evaluate.
 */

// parseInt("fffffffffffffff", 16) + 1: the denominator every implementation of
// the scheme divides the 15-hex-digit prefix by.
const FLAG_HASH_DENOMINATOR = 2 ** 60;

function sha1Unit(input: string): number {
  const hex = createHash("sha1").update(input).digest("hex").slice(0, 15);
  return parseInt(hex, 16) / FLAG_HASH_DENOMINATOR;
}

/** Rollout bucket for a (flag, user) pair, in [0,1). */
export function flagBucket(flagKey: string, distinctId: string): number {
  return sha1Unit(`${flagKey}.${distinctId}`);
}

/** Variant-selection hash for a (flag, user) pair, in [0,1). */
export function flagVariantHash(flagKey: string, distinctId: string): number {
  return sha1Unit(`${flagKey}.${distinctId}variant`);
}

// Walk the variants in stored order over cumulative rolloutPct/100 ranges and
// pick the one whose range contains the variant hash.
function selectVariant(
  flag: { key: string; variants: FlagVariant[] },
  distinctId: string,
): FlagVariant | null {
  if (flag.variants.length === 0) return null;
  const vhash = flagVariantHash(flag.key, distinctId);
  let cumulative = 0;
  for (const variant of flag.variants) {
    cumulative += variant.rolloutPct / 100;
    if (vhash < cumulative) return variant;
  }
  // Guard against float drift on the last range boundary (sums are validated
  // to exactly 100 at write time).
  return flag.variants[flag.variants.length - 1];
}

/**
 * Evaluate one flag definition for a distinct id, in-process. Rules are walked
 * in stored order and the first match wins, exactly as the server does.
 * Callers must not pass a definition with `localEvaluable: false`.
 */
export function evaluateFlagLocally(
  flag: FlagDefinition,
  distinctId: string,
): FlagResult {
  if (!flag.active) {
    return { enabled: false, variant: null, payload: null, reason: "inactive" };
  }
  const rules = flag.rules ?? [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    // ADR-0011: raw id only, no canonical resolution locally.
    if (rule.distinctIds && !rule.distinctIds.includes(distinctId)) continue;
    if (rule.cohortId !== undefined) continue; // unreachable: not localEvaluable
    if (flagBucket(flag.key, distinctId) >= rule.rolloutPct / 100) continue;
    const named = rule.variant
      ? flag.variants.find((v) => v.key === rule.variant)
      : undefined;
    const variant = named ?? selectVariant(flag, distinctId);
    return {
      enabled: true,
      variant: variant?.key ?? null,
      payload: variant?.payload ?? null,
      reason: `rule:${i}`,
    };
  }
  return { enabled: false, variant: null, payload: null, reason: "no_match" };
}
