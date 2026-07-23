import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultProperties } from "../src/defaults.js";
import { VERSION } from "../src/version.js";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

describe("getDefaultProperties", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes $lib_version, $browser, $os, $current_url", () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    const props = getDefaultProperties();
    expect(props.$lib_version).toBe(VERSION);
    expect(props.$browser).toBe("Chrome");
    expect(props.$browser_version).toBe("120.0.0.0");
    expect(props.$os).toBe("Windows");
    expect(typeof props.$current_url).toBe("string");
    // desktop -> no $device
    expect(props.$device).toBeUndefined();
    expect(props.$screen_width).toBeTypeOf("number");
    expect(props.$screen_height).toBeTypeOf("number");
  });

  it("detects iPhone device and iOS", () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    );
    const props = getDefaultProperties();
    expect(props.$os).toBe("iOS");
    expect(props.$device).toBe("iPhone");
    expect(props.$browser).toBe("Safari");
    expect(props.$browser_version).toBe("17.0");
  });

  it("extracts Android model name best-effort", () => {
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    );
    const props = getDefaultProperties();
    expect(props.$os).toBe("Android");
    expect(props.$device).toBe("SM-G991B");
  });

  it("parses Edge and Firefox versions", () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.61",
    );
    expect(getDefaultProperties().$browser).toBe("Edge");
    expect(getDefaultProperties().$browser_version).toBe("120.0.2210.61");

    setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    );
    expect(getDefaultProperties().$browser).toBe("Firefox");
    expect(getDefaultProperties().$browser_version).toBe("121.0");
    expect(getDefaultProperties().$os).toBe("Linux");
  });
});
