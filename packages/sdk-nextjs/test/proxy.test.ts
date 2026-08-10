import { afterEach, describe, expect, it, vi } from "vitest";
import { createCohorlyProxy } from "../src/server.js";

function fetchMock(body: unknown = { flags: {} }) {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function post(path: string, body: unknown) {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCohorlyProxy", () => {
  it("forwards /flags/evaluate upstream, matching the two-segment path", async () => {
    const mock = fetchMock({ flags: { banner: { enabled: true } } });
    const { POST } = createCohorlyProxy({ apiHost: "http://localhost:4000" });

    const res = await POST(
      post("/api/cohorly/flags/evaluate", { distinct_id: "u1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flags: { banner: { enabled: true } } });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("http://localhost:4000/flags/evaluate");
    expect(JSON.parse(init.body)).toEqual({ distinct_id: "u1" });
  });

  it("injects the server-side token into a forwarded flag evaluation", async () => {
    const mock = fetchMock();
    const { POST } = createCohorlyProxy({
      apiHost: "http://localhost:4000",
      token: "tok-srv",
    });

    await POST(post("/api/cohorly/flags/evaluate", { distinct_id: "u1" }));

    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
      distinct_id: "u1",
      token: "tok-srv",
    });
  });

  it("still forwards single-segment ingestion paths", async () => {
    const mock = fetchMock({ status: 1 });
    const { POST } = createCohorlyProxy({ apiHost: "http://localhost:4000" });

    await POST(post("/api/cohorly/track", [{ event: "e", properties: {} }]));
    expect(mock.mock.calls[0][0]).toBe("http://localhost:4000/track");
  });

  it("404s an unknown path, and a bare `evaluate` without its `flags` prefix", async () => {
    fetchMock();
    const { POST } = createCohorlyProxy({ apiHost: "http://localhost:4000" });

    expect((await POST(post("/api/cohorly/nope", {}))).status).toBe(404);
    expect((await POST(post("/api/cohorly/evaluate", {}))).status).toBe(404);
  });
});
