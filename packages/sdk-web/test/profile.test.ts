import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfileDefaults } from "../src/index.js";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

describe("getProfileDefaults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("includes device profile defaults ($os/$browser/$browser_version)", () => {
    const defaults = getProfileDefaults();
    expect(defaults.$os).toBe("Windows");
    expect(defaults.$browser).toBe("Chrome");
    expect(defaults.$browser_version).toBe("120.0.0.0");
  });

  it("includes persisted first-touch $initial_referrer / $initial_referring_domain", () => {
    window.localStorage.setItem(
      "cohorly_first_touch",
      JSON.stringify({
        $initial_referrer: "https://news.example.com/post",
        $initial_referring_domain: "news.example.com",
      }),
    );
    const defaults = getProfileDefaults();
    expect(defaults.$initial_referrer).toBe("https://news.example.com/post");
    expect(defaults.$initial_referring_domain).toBe("news.example.com");
  });

  it("caller-supplied keys win when merged over the defaults", () => {
    const merged = { ...getProfileDefaults(), $browser: "CustomBrowser", $os: "CustomOS" };
    expect(merged.$browser).toBe("CustomBrowser");
    expect(merged.$os).toBe("CustomOS");
  });
});
