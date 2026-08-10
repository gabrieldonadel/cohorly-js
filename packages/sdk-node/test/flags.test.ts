import { describe, expect, it } from "vitest";
import { CohorlyNode } from "../src/index.js";
import { TransportError } from "../src/transport.js";
import type { CohorlyFetcher, FlagResult } from "../src/types.js";

const flagsResponse: { flags: Record<string, FlagResult> } = {
  flags: {
    checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
    banner: {
      enabled: true,
      variant: "blue",
      payload: { color: "#00f" },
      reason: "rule:1",
    },
    hidden: { enabled: false, variant: null, payload: null, reason: "no_match" },
  },
};

interface FetchedRequest {
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeClient(respond?: (n: number) => unknown) {
  const requests: FetchedRequest[] = [];
  const fetcher: CohorlyFetcher = async (url, body, headers) => {
    requests.push({ url, path: new URL(url).pathname, body, headers });
    const out = respond?.(requests.length) ?? flagsResponse;
    if (out instanceof Error) throw out;
    return out;
  };
  const client = new CohorlyNode("tok-f", { flushIntervalMs: 0, fetcher });
  return { client, requests };
}

describe("flags", () => {
  it("isFeatureEnabled posts distinct_id + flag_keys with the token header", async () => {
    const { client, requests } = makeClient();
    const enabled = await client.flags.isFeatureEnabled("checkout", "u1");
    expect(enabled).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/flags/evaluate");
    expect(requests[0].url).toBe(
      "https://cohorly-service.velloalabs.com/flags/evaluate",
    );
    expect(requests[0].body).toEqual({
      distinct_id: "u1",
      flag_keys: ["checkout"],
    });
    expect(requests[0].headers["X-Cohorly-Token"]).toBe("tok-f");
  });

  it("isFeatureEnabled is false for disabled and unknown flags", async () => {
    const { client } = makeClient();
    expect(await client.flags.isFeatureEnabled("hidden", "u1")).toBe(false);
    expect(await client.flags.isFeatureEnabled("nope", "u1")).toBe(false);
  });

  it("getFeatureFlag returns the variant key, else the enabled bool", async () => {
    const { client, requests } = makeClient();
    expect(await client.flags.getFeatureFlag("banner", "u1")).toBe("blue");
    expect(await client.flags.getFeatureFlag("checkout", "u1")).toBe(true);
    expect(await client.flags.getFeatureFlag("nope", "u1")).toBe(false);
    expect(requests[0].body).toMatchObject({ flag_keys: ["banner"] });
  });

  it("getFeatureFlagPayload returns the payload, null when absent", async () => {
    const { client } = makeClient();
    expect(await client.flags.getFeatureFlagPayload("banner", "u1")).toEqual({
      color: "#00f",
    });
    expect(await client.flags.getFeatureFlagPayload("checkout", "u1")).toBeNull();
    expect(await client.flags.getFeatureFlagPayload("nope", "u1")).toBeNull();
  });

  it("getAllFlags omits flag_keys and returns the whole map", async () => {
    const { client, requests } = makeClient();
    const all = await client.flags.getAllFlags("u1");
    expect(all).toEqual(flagsResponse.flags);
    expect(requests[0].body).toEqual({ distinct_id: "u1" });
    expect("flag_keys" in (requests[0].body as object)).toBe(false);
  });

  it("supports the callback style", async () => {
    const { client } = makeClient();
    const result = await new Promise<boolean | string | undefined>(
      (resolve, reject) => {
        void client.flags
          .getFeatureFlag("banner", "u1", (err, value) =>
            err ? reject(err) : resolve(value),
          )
          .catch(() => {});
      },
    );
    expect(result).toBe("blue");
  });

  it("failures surface via promise and callback, and are not retried", async () => {
    const { client, requests } = makeClient(() => new TransportError(500));
    await expect(client.flags.getAllFlags("u1")).rejects.toThrow();
    const err = await new Promise<Error | undefined>((resolve) => {
      void client.flags
        .isFeatureEnabled("checkout", "u1", (e) => resolve(e))
        .catch(() => {});
    });
    expect(err).toBeInstanceOf(TransportError);
    expect(requests).toHaveLength(2); // one request per call, no retries
  });

  it("requires a distinct_id", async () => {
    const { client } = makeClient();
    await expect(client.flags.isFeatureEnabled("checkout", "")).rejects.toThrow(
      /distinct_id is required/,
    );
  });
});
