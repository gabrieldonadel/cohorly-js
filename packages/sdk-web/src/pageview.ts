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
