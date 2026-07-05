import { describe, expect, it } from "vitest";
import { CohorlyNode } from "../src/index.js";
import type { EngagePayload } from "../src/types.js";
import { createMockTransport } from "./helpers.js";

function engageBodies(requests: { path: string; body: unknown }[]) {
  return requests
    .filter((r) => r.path === "/engage")
    .map((r) => r.body as EngagePayload);
}

function makeClient(respond?: (n: number) => { status: number }) {
  const { transport, requests } = createMockTransport(respond);
  const client = new CohorlyNode("tok-p", { flushIntervalMs: 0, transport });
  return { client, requests };
}

describe("people", () => {
  it("set: object form -> $set", async () => {
    const { client, requests } = makeClient();
    await client.people.set("u1", { plan: "premium", name: "sam" });
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $set: { plan: "premium", name: "sam" } },
    ]);
    expect(requests[0].headers["X-Cohorly-Token"]).toBe("tok-p");
  });

  it("set: key/value form", async () => {
    const { client, requests } = makeClient();
    await client.people.set("u1", "plan", "free");
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $set: { plan: "free" } },
    ]);
  });

  it("set_once / setOnce -> $set_once", async () => {
    const { client, requests } = makeClient();
    await client.people.set_once("u1", { first_seen: "2026-01-01" });
    await client.people.setOnce("u1", "source", "ads");
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $set_once: { first_seen: "2026-01-01" } },
      { distinct_id: "u1", $set_once: { source: "ads" } },
    ]);
  });

  it("increment: single prop defaults to 1, accepts amount and object", async () => {
    const { client, requests } = makeClient();
    await client.people.increment("u1", "logins");
    await client.people.increment("u1", "credits", 5);
    await client.people.increment("u1", { logins: 2, credits: -1 });
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $add: { logins: 1 } },
      { distinct_id: "u1", $add: { credits: 5 } },
      { distinct_id: "u1", $add: { logins: 2, credits: -1 } },
    ]);
  });

  it("increment: callback in the amount position", async () => {
    const { client, requests } = makeClient();
    const err = await new Promise<Error | undefined>((resolve) => {
      void client.people.increment("u1", "logins", resolve);
    });
    expect(err).toBeUndefined();
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $add: { logins: 1 } },
    ]);
  });

  it("unset: single key and array -> $unset", async () => {
    const { client, requests } = makeClient();
    await client.people.unset("u1", "plan");
    await client.people.unset("u1", ["a", "b"]);
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $unset: ["plan"] },
      { distinct_id: "u1", $unset: ["a", "b"] },
    ]);
  });

  it("delete_user / deleteUser -> $delete", async () => {
    const { client, requests } = makeClient();
    await client.people.delete_user("u1");
    await client.people.deleteUser("u2");
    expect(engageBodies(requests)).toEqual([
      { distinct_id: "u1", $delete: true },
      { distinct_id: "u2", $delete: true },
    ]);
  });

  it("engage failures surface via promise and callback, and are not retried", async () => {
    const { client, requests } = makeClient(() => ({ status: 500 }));
    await expect(client.people.set("u1", { a: 1 })).rejects.toThrow();
    const err = await new Promise<Error | undefined>((resolve) => {
      void client.people.set("u1", { a: 1 }, resolve).catch(() => {});
    });
    expect(err).toBeInstanceOf(Error);
    expect(requests).toHaveLength(2); // one request per call, no retries
  });

  it("requires a distinct_id", async () => {
    const { client } = makeClient();
    await expect(client.people.set("", { a: 1 })).rejects.toThrow(
      /distinct_id is required/,
    );
  });
});

describe("alias", () => {
  it("posts { alias, distinct_id } to /alias with the token header", async () => {
    const { client, requests } = makeClient();
    await client.alias("user-1", "anon-42");
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/alias");
    expect(requests[0].body).toEqual({ alias: "anon-42", distinct_id: "user-1" });
    expect(requests[0].headers["X-Cohorly-Token"]).toBe("tok-p");
  });

  it("supports the callback style", async () => {
    const { client } = makeClient();
    const err = await new Promise<Error | undefined>((resolve) => {
      void client.alias("user-1", "anon-42", resolve);
    });
    expect(err).toBeUndefined();
  });
});
