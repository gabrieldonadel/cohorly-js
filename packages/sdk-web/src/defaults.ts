/** Best-effort browser/OS parsing from the user agent string, Mixpanel-style default props. */
function parseBrowser(ua: string): string {
  if (/edg/i.test(ua)) return "Edge";
  if (/opr\//i.test(ua)) return "Opera";
  if (/chrome|crios/i.test(ua) && !/edg/i.test(ua)) return "Chrome";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua) && !/chrome|crios|android/i.test(ua)) return "Safari";
  return "Unknown";
}

function parseOs(ua: string): string {
  if (/windows/i.test(ua)) return "Windows";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "Unknown";
}

/** Default event properties captured on every event when running in a browser. Empty during SSR. */
export function getDefaultProperties(): Record<string, unknown> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {};
  }
  const ua = navigator.userAgent ?? "";
  const props: Record<string, unknown> = {
    $browser: parseBrowser(ua),
    $os: parseOs(ua),
    $current_url: window.location?.href,
  };
  if (typeof screen !== "undefined") {
    props.$screen_width = screen.width;
    props.$screen_height = screen.height;
  }
  return props;
}
