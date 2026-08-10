import { describe, expect, it } from "vitest";
import { CohorlyNode } from "../src/index.js";
import {
  evaluateFlagLocally,
  flagBucket,
  flagVariantHash,
} from "../src/local-eval.js";
import { TransportError } from "../src/transport.js";
import type {
  CohorlyFetcher,
  CohorlyGetFetcher,
  FlagDefinition,
  FlagResult,
} from "../src/types.js";
import { createMockTransport, trackBodies } from "./helpers.js";

/**
 * Hash parity vectors, cross-checked against the server implementation in
 * apps/server/src/store.ts (the first row is also the server's own committed
 * test vector in apps/server/src/flags.test.ts). If these ever drift, every
 * flag re-buckets - fix the SDK, never the vectors.
 */
const VECTORS: [string, string, number, number][] = [
  ["test-flag", "user-1", 0.007041759849595705, 0.5657896835491947],
  ["test-flag", "user-2", 0.41280181684975514, 0.4070465583136967],
  ["checkout", "u1", 0.42195181415092653, 0.7192194727448631],
  ["banner", "alice", 0.9753024097444066, 0.8311692753373251],
  ["new-nav", "device-abc", 0.9966119669822074, 0.9930224532916947],
];

const def = (over: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key: "checkout",
  name: "Checkout",
  active: true,
  variants: [],
  rules: [{ rolloutPct: 100 }],
  localEvaluable: true,
  ...over,
});

/** Client whose definitions poller is fed from `flags`, with a mock fetcher. */
function makeClient(opts: {
  flags?: FlagDefinition[];
  definitionsError?: () => unknown;
  remote?: Record<string, FlagResult>;
  remoteError?: boolean;
}) {
  const posts: { url: string; body: unknown }[] = [];
  const gets: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: CohorlyFetcher = async (url, body) => {
    posts.push({ url, body });
    if (opts.remoteError) throw new TransportError(500);
    return { flags: opts.remote ?? {} };
  };
  const definitionsFetcher: CohorlyGetFetcher = async (url, headers) => {
    gets.push({ url, headers });
    const err = opts.definitionsError?.();
    if (err) throw err;
    return { flags: opts.flags ?? [] };
  };
  const { transport, requests } = createMockTransport();
  const client = new CohorlyNode("tok-l", {
    flushIntervalMs: 0,
    fetcher,
    transport,
    definitionsFetcher,
    flagSecret: "fs_secret",
    flagPollIntervalMs: 0,
  });
  return { client, posts, gets, tracked: requests };
}

describe("local flag hashing", () => {
  it("matches the server hash on known vectors", () => {
    for (const [key, id, bucket, variant] of VECTORS) {
      expect(flagBucket(key, id)).toBe(bucket);
      expect(flagVariantHash(key, id)).toBe(variant);
    }
  });

  it("buckets on rolloutPct like the server", () => {
    // flagBucket("test-flag", "user-1") ~= 0.00704
    expect(evaluateFlagLocally(
      def({ key: "test-flag", rules: [{ rolloutPct: 1 }] }),
      "user-1",
    ).enabled).toBe(true);
    expect(evaluateFlagLocally(
      def({ key: "test-flag", rules: [{ rolloutPct: 0 }] }),
      "user-1",
    ).enabled).toBe(false);
    // ~0.41 for user-2: in at 50%, out at 30%.
    expect(evaluateFlagLocally(
      def({ key: "test-flag", rules: [{ rolloutPct: 50 }] }),
      "user-2",
    ).reason).toBe("rule:0");
    expect(evaluateFlagLocally(
      def({ key: "test-flag", rules: [{ rolloutPct: 30 }] }),
      "user-2",
    ).reason).toBe("no_match");
  });

  it("reports inactive flags without consulting rules", () => {
    expect(evaluateFlagLocally(def({ active: false }), "u1")).toEqual({
      enabled: false,
      variant: null,
      payload: null,
      reason: "inactive",
    });
  });

  it("takes the first matching rule and honors Overrides on the raw id", () => {
    const flag = def({
      rules: [
        { distinctIds: ["qa-user"], rolloutPct: 100 },
        { rolloutPct: 0 },
      ],
    });
    expect(evaluateFlagLocally(flag, "qa-user").reason).toBe("rule:0");
    expect(evaluateFlagLocally(flag, "u1").reason).toBe("no_match");
  });

  it("selects a variant by cumulative range, or the rule's named variant", () => {
    // flagVariantHash("checkout", "u1") ~= 0.719 -> second of 50/50.
    const flag = def({
      variants: [
        { key: "control", rolloutPct: 50 },
        { key: "treat", payload: { n: 1 }, rolloutPct: 50 },
      ],
    });
    expect(evaluateFlagLocally(flag, "u1")).toEqual({
      enabled: true,
      variant: "treat",
      payload: { n: 1 },
      reason: "rule:0",
    });
    const forced = def({
      variants: flag.variants,
      rules: [{ rolloutPct: 100, variant: "control" }],
    });
    expect(evaluateFlagLocally(forced, "u1").variant).toBe("control");
  });
});

describe("local evaluation routing", () => {
  it("evaluates locally with no network once definitions are loaded", async () => {
    const { client, posts, gets } = makeClient({ flags: [def()] });
    await client.flagDefinitionsReady;
    expect(gets).toHaveLength(1);
    expect(gets[0].url).toBe(
      "https://cohorly-service.velloalabs.com/flags/local-evaluation",
    );
    expect(gets[0].headers.Authorization).toBe("Bearer fs_secret");
    expect(await client.flags.isFeatureEnabled("checkout", "u1")).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("falls back to /flags/evaluate before definitions arrive", async () => {
    const { client, posts } = makeClient({
      flags: [def()],
      remote: {
        checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
      },
    });
    expect(await client.flags.isFeatureEnabled("checkout", "u1")).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain("/flags/evaluate");
  });

  it("falls back remotely for cohort flags and unknown keys", async () => {
    const cohortFlag = def({
      key: "vip",
      rules: [{ cohortId: 7, rolloutPct: 100 }],
      localEvaluable: false,
    });
    const { client, posts } = makeClient({
      flags: [def(), cohortFlag],
      remote: {
        vip: { enabled: true, variant: null, payload: null, reason: "rule:0" },
      },
    });
    await client.flagDefinitionsReady;
    expect(await client.flags.isFeatureEnabled("vip", "u1")).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ distinct_id: "u1", flag_keys: ["vip"] });

    await client.flags.isFeatureEnabled("mystery", "u1");
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual({ distinct_id: "u1", flag_keys: ["mystery"] });
  });

  it("getAllFlags merges local results with a remote leg for the rest", async () => {
    const cohortFlag = def({
      key: "vip",
      rules: [{ cohortId: 7, rolloutPct: 100 }],
      localEvaluable: false,
    });
    const { client, posts } = makeClient({
      flags: [def(), cohortFlag],
      remote: {
        vip: { enabled: true, variant: null, payload: null, reason: "rule:0" },
      },
    });
    await client.flagDefinitionsReady;
    const all = await client.flags.getAllFlags("u1");
    expect(Object.keys(all).sort()).toEqual(["checkout", "vip"]);
    expect(all.checkout.reason).toBe("rule:0");
    expect(posts[0].body).toEqual({ distinct_id: "u1", flag_keys: ["vip"] });
  });

  it("getAllFlags omits non-local flags when the remote leg fails", async () => {
    const cohortFlag = def({
      key: "vip",
      rules: [{ cohortId: 7, rolloutPct: 100 }],
      localEvaluable: false,
    });
    const { client } = makeClient({
      flags: [def(), cohortFlag],
      remoteError: true,
    });
    await client.flagDefinitionsReady;
    const all = await client.flags.getAllFlags("u1");
    expect(Object.keys(all)).toEqual(["checkout"]);
  });

  it("still requires a distinct_id in local mode", async () => {
    const { client } = makeClient({ flags: [def()] });
    await client.flagDefinitionsReady;
    await expect(client.flags.isFeatureEnabled("checkout", "")).rejects.toThrow(
      /distinct_id is required/,
    );
  });
});

describe("definitions poller", () => {
  it("keeps the last definitions when a poll fails", async () => {
    let calls = 0;
    const { client, posts } = makeClient({
      flags: [def()],
      definitionsError: () => (++calls > 1 ? new TransportError(500) : undefined),
    });
    await client.flagDefinitionsReady;
    // Second poll fails; the first payload survives, so still no network.
    await (client as unknown as { definitions: { refresh(): Promise<void> } })
      .definitions.refresh();
    expect(await client.flags.isFeatureEnabled("checkout", "u1")).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("keeps falling back remotely on a 401 and does not throw", async () => {
    const { client, posts } = makeClient({
      flags: [def()],
      definitionsError: () => new TransportError(401),
      remote: {},
    });
    await client.flagDefinitionsReady;
    expect(await client.flags.isFeatureEnabled("checkout", "u1")).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it("shutdown stops the poller", async () => {
    const { client, gets } = makeClient({ flags: [def()] });
    await client.flagDefinitionsReady;
    await client.shutdown();
    const before = gets.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(gets).toHaveLength(before);
  });
});

describe("exposure events", () => {
  it("queues $feature_flag_called only when asked", async () => {
    const { client, tracked } = makeClient({
      flags: [
        def({
          variants: [
            { key: "control", rolloutPct: 50 },
            { key: "treat", rolloutPct: 50 },
          ],
        }),
      ],
    });
    await client.flagDefinitionsReady;

    await client.flags.isFeatureEnabled("checkout", "u1");
    await client.flush();
    expect(tracked).toHaveLength(0);

    await client.flags.isFeatureEnabled("checkout", "u1", {
      sendExposureEvent: true,
    });
    await client.flush();
    const [batch] = trackBodies(tracked);
    expect(batch).toHaveLength(1);
    const event = batch[0] as { event: string; properties: Record<string, unknown> };
    expect(event.event).toBe("$feature_flag_called");
    expect(event.properties.distinct_id).toBe("u1");
    expect(event.properties.$feature_flag).toBe("checkout");
    // Variant flag: the response is the variant key, not the boolean.
    expect(event.properties.$feature_flag_response).toBe("treat");
  });

  it("sends the enabled boolean for boolean flags and nothing for unknown keys", async () => {
    const { client, tracked } = makeClient({ flags: [def()], remote: {} });
    await client.flagDefinitionsReady;
    await client.flags.getFeatureFlag("checkout", "u1", {
      sendExposureEvent: true,
    });
    await client.flags.getFeatureFlagPayload("mystery", "u1", {
      sendExposureEvent: true,
    });
    await client.flush();
    const events = trackBodies(tracked).flat() as {
      properties: Record<string, unknown>;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0].properties.$feature_flag_response).toBe(true);
  });

  it("keeps the callback-in-third-position signature working", async () => {
    const { client, tracked } = makeClient({ flags: [def()] });
    await client.flagDefinitionsReady;
    const value = await new Promise<boolean | undefined>((resolve, reject) => {
      void client.flags
        .isFeatureEnabled("checkout", "u1", (err, v) =>
          err ? reject(err) : resolve(v),
        )
        .catch(() => {});
    });
    expect(value).toBe(true);
    await client.flush();
    expect(tracked).toHaveLength(0); // no options object = no exposure event
  });

  it("supports options plus callback together", async () => {
    const { client, tracked } = makeClient({ flags: [def()] });
    await client.flagDefinitionsReady;
    const value = await new Promise<boolean | undefined>((resolve, reject) => {
      void client.flags
        .isFeatureEnabled("checkout", "u1", { sendExposureEvent: true }, (err, v) =>
          err ? reject(err) : resolve(v),
        )
        .catch(() => {});
    });
    expect(value).toBe(true);
    await client.flush();
    expect(trackBodies(tracked).flat()).toHaveLength(1);
  });
});
