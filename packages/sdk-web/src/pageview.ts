/** Mixpanel-compatible automatic web pageview event name. */
export const PAGEVIEW_EVENT = "$mp_web_page_view";

/**
 * Properties for a `$mp_web_page_view` event, derived from the current
 * location/document. Empty during SSR.
 */
export function getPageviewProperties(): Record<string, unknown> {
  if (typeof window === "undefined" || typeof location === "undefined") {
    return {};
  }
  const props: Record<string, unknown> = {
    $current_url: location.href,
    current_domain: location.hostname,
    current_url_path: location.pathname,
    current_url_search: location.search,
  };
  if (typeof document !== "undefined") {
    props.current_page_title = document.title;
  }
  return props;
}

/**
 * Wire up SPA pageview autotracking by monkey-patching history.pushState /
 * replaceState (so route changes from client-side routers fire) and
 * listening to popstate (back/forward navigation). No-op during SSR.
 */
export function setupPageviewAutotrack(onNavigate: () => void): void {
  if (typeof window === "undefined" || typeof history === "undefined") return;

  const wrap = (method: "pushState" | "replaceState") => {
    const original = history[method];
    history[method] = function patched(
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      const result = original.apply(this, args);
      onNavigate();
      return result;
    } as History["pushState"];
  };

  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", onNavigate);
}
