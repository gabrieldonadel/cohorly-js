import type { CohorlyStorage } from "@cohorly/core";
import { describe, expect, it, vi } from "vitest";
import {
  getAttributionProperties,
  initAttribution,
  parseReferrer,
  parseUtm,
  referringDomain,
} from "../src/attribution.js";

function fakeStorage(): CohorlyStorage {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

describe("parseUtm", () => {
  it("captures only present utm params", () => {
    const utm = parseUtm("?utm_source=newsletter&utm_medium=email&foo=bar");
    expect(utm).toEqual({ utm_source: "newsletter", utm_medium: "email" });
  });

  it("returns empty when none present", () => {
    expect(parseUtm("?a=1")).toEqual({});
    expect(parseUtm("")).toEqual({});
  });
});

describe("parseUtm ad click IDs", () => {
  it("captures utm_id and ad click IDs alongside UTMs", () => {
    const params = parseUtm(
      "?utm_source=news&utm_id=camp42&gclid=abc&fbclid=def&msclkid=ghi&ttclid=jkl&nope=1",
    );
    expect(params).toEqual({
      utm_source: "news",
      utm_id: "camp42",
      gclid: "abc",
      fbclid: "def",
      msclkid: "ghi",
      ttclid: "jkl",
    });
  });

  it("registers click IDs as super props and initial_<name> first-touch", () => {
    const storage = fakeStorage();
    const register = vi.fn();
    const setOnce = vi.fn();
    initAttribution(storage, { register, setOnce }, {
      search: "?gclid=xyz&utm_source=google",
      referrer: "https://www.google.com/",
    });
    expect(register).toHaveBeenCalledWith({
      gclid: "xyz",
      utm_source: "google",
    });
    const firstTouch = setOnce.mock.calls[0][0];
    expect(firstTouch.initial_gclid).toBe("xyz");
    expect(firstTouch.initial_utm_source).toBe("google");
  });
});

describe("referringDomain", () => {
  it("returns hostname", () => {
    expect(referringDomain("https://www.google.com/search?q=x")).toBe("www.google.com");
  });
  it("returns $direct for empty/invalid", () => {
    expect(referringDomain("")).toBe("$direct");
    expect(referringDomain("not a url")).toBe("$direct");
  });
});

describe("parseReferrer", () => {
  it("returns referrer + domain for a normal referrer", () => {
    const props = parseReferrer("https://example.com/blog/post");
    expect(props.$referrer).toBe("https://example.com/blog/post");
    expect(props.$referring_domain).toBe("example.com");
    expect(props.$search_engine).toBeUndefined();
  });

  it("detects google search engine + keyword from q", () => {
    const props = parseReferrer("https://www.google.com/search?q=cohorly+analytics");
    expect(props.$search_engine).toBe("google");
    expect(props.mp_keyword).toBe("cohorly analytics");
  });

  it("detects yahoo keyword from p param", () => {
    const props = parseReferrer("https://search.yahoo.com/search?p=hello+world");
    expect(props.$search_engine).toBe("yahoo");
    expect(props.mp_keyword).toBe("hello world");
  });

  it("empty referrer -> empty object", () => {
    expect(parseReferrer("")).toEqual({});
  });
});

describe("initAttribution first-touch", () => {
  it("registers utm super props and set_once first touch on first visit", () => {
    const storage = fakeStorage();
    const register = vi.fn();
    const setOnce = vi.fn();
    initAttribution(storage, { register, setOnce }, {
      search: "?utm_source=twitter&utm_campaign=launch",
      referrer: "https://t.co/abc",
    });

    expect(register).toHaveBeenCalledWith({
      utm_source: "twitter",
      utm_campaign: "launch",
    });
    expect(setOnce).toHaveBeenCalledTimes(1);
    const firstTouch = setOnce.mock.calls[0][0];
    expect(firstTouch.$initial_referrer).toBe("https://t.co/abc");
    expect(firstTouch.$initial_referring_domain).toBe("t.co");
    expect(firstTouch.initial_utm_source).toBe("twitter");
    expect(firstTouch.initial_utm_campaign).toBe("launch");
  });

  it("does not re-run set_once on subsequent visits", () => {
    const storage = fakeStorage();
    initAttribution(storage, { register: vi.fn(), setOnce: vi.fn() }, {
      search: "?utm_source=a",
      referrer: "https://x.com/",
    });
    const setOnce = vi.fn();
    initAttribution(storage, { register: vi.fn(), setOnce }, {
      search: "?utm_source=b",
      referrer: "https://y.com/",
    });
    expect(setOnce).not.toHaveBeenCalled();
  });

  it("persists $direct when no referrer", () => {
    const storage = fakeStorage();
    const setOnce = vi.fn();
    initAttribution(storage, { register: vi.fn(), setOnce }, {
      search: "",
      referrer: "",
    });
    expect(setOnce.mock.calls[0][0].$initial_referrer).toBe("$direct");
    expect(setOnce.mock.calls[0][0].$initial_referring_domain).toBe("$direct");
  });
});

describe("getAttributionProperties", () => {
  it("merges current referrer info with persisted first-touch", () => {
    const storage = fakeStorage();
    initAttribution(storage, { register: vi.fn(), setOnce: vi.fn() }, {
      search: "",
      referrer: "https://first.example.com/",
    });
    const props = getAttributionProperties(storage, {
      referrer: "https://www.bing.com/search?q=foo",
      search: "",
    });
    expect(props.$initial_referrer).toBe("https://first.example.com/");
    expect(props.$initial_referring_domain).toBe("first.example.com");
    expect(props.$referrer).toBe("https://www.bing.com/search?q=foo");
    expect(props.$search_engine).toBe("bing");
    expect(props.mp_keyword).toBe("foo");
  });
});
