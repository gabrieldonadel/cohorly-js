import { VERSION } from "./version.js";

/** Best-effort browser/OS parsing from the user agent string, Mixpanel-style default props. */
function parseBrowser(ua: string): string {
  if (/edg/i.test(ua)) return "Edge";
  if (/opr\//i.test(ua)) return "Opera";
  if (/chrome|crios/i.test(ua) && !/edg/i.test(ua)) return "Chrome";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua) && !/chrome|crios|android/i.test(ua)) return "Safari";
  return "Unknown";
}

/** Extract the reported version number for the detected browser (best-effort). */
function parseBrowserVersion(ua: string, browser: string): string | undefined {
  const patterns: Record<string, RegExp> = {
    Edge: /edg(?:e|a|ios)?\/([\d.]+)/i,
    Opera: /opr\/([\d.]+)/i,
    Chrome: /(?:chrome|crios)\/([\d.]+)/i,
    Firefox: /(?:firefox|fxios)\/([\d.]+)/i,
    Safari: /version\/([\d.]+)/i,
  };
  const re = patterns[browser];
  if (!re) return undefined;
  const match = ua.match(re);
  return match ? match[1] : undefined;
}

function parseOs(ua: string): string {
  if (/windows/i.test(ua)) return "Windows";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "Unknown";
}

/**
 * Best-effort mobile device name from the UA. Desktop browsers return undefined
 * (Mixpanel only sets `$device` on mobile). Android tries to extract the model.
 */
function parseDevice(ua: string): string | undefined {
  if (/ipad/i.test(ua)) return "iPad";
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipod/i.test(ua)) return "iPod";
  if (/android/i.test(ua)) {
    // "...; SM-G991B Build/..." -> "SM-G991B"
    const model = ua.match(/;\s*([^;)]+?)\s+Build\//i);
    if (model?.[1]) return model[1].trim();
    return "Android";
  }
  return undefined;
}

/** Default event properties captured on every event when running in a browser. Empty during SSR. */
export function getDefaultProperties(): Record<string, unknown> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {};
  }
  const ua = navigator.userAgent ?? "";
  const browser = parseBrowser(ua);
  const props: Record<string, unknown> = {
    $browser: browser,
    $os: parseOs(ua),
    $current_url: window.location?.href,
    $lib_version: VERSION,
  };
  const browserVersion = parseBrowserVersion(ua, browser);
  if (browserVersion !== undefined) props.$browser_version = browserVersion;
  const device = parseDevice(ua);
  if (device !== undefined) props.$device = device;
  if (typeof screen !== "undefined") {
    props.$screen_width = screen.width;
    props.$screen_height = screen.height;
  }
  return props;
}
