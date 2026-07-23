/**
 * Opt-in DOM autocapture: `$mp_click`, `$mp_submit`, `$mp_scroll`,
 * `$mp_rage_click`, `$mp_dead_click`. Never captures input values; element text
 * is only captured when explicitly opted into via `captureTextContent`.
 */

export interface AutocaptureConfig {
  clicks?: boolean;
  submits?: boolean;
  scroll?: boolean;
  /**
   * Fire `$mp_rage_click` on rapid repeated clicks in the same spot
   * (frustration signal). Default true when autocapture is enabled.
   */
  rageClicks?: boolean;
  /**
   * Fire `$mp_dead_click` when a click on an interactive element produces no DOM
   * change and no navigation. Default true when autocapture is enabled.
   */
  deadClicks?: boolean;
  /** When true, include a (trimmed, <=255 char) `$el_text`. Default false. */
  captureTextContent?: boolean;
  /** CSS selectors; if a target `.closest()`-matches one, the event is skipped. */
  blockSelectors?: string[];
  /** Scroll-depth percentages to fire `$mp_scroll` at. Default [25, 50, 75, 100]. */
  scrollCheckpoints?: number[];
}

export type AutocaptureOption = boolean | AutocaptureConfig;

interface ResolvedConfig {
  clicks: boolean;
  submits: boolean;
  scroll: boolean;
  rageClicks: boolean;
  deadClicks: boolean;
  captureTextContent: boolean;
  blockSelectors: string[];
  scrollCheckpoints: number[];
}

const DEFAULT_CHECKPOINTS = [25, 50, 75, 100];
const MAX_TEXT_LENGTH = 255;

/** Rage click: this many clicks... */
const RAGE_MIN_CLICKS = 4;
/** ...within this window (ms)... */
const RAGE_WINDOW_MS = 1000;
/** ...within this radius (px) of each other fire one `$mp_rage_click`. */
const RAGE_RADIUS_PX = 30;
/** Dead click: no DOM mutation / navigation within this window (ms) -> fire. */
const DEAD_CLICK_TIMEOUT_MS = 500;

/** Interactive elements we treat as click targets. */
const CLICK_SELECTOR =
  'a, button, [role="button"], input[type="button"], input[type="submit"]';

function resolveConfig(option: AutocaptureOption | undefined): ResolvedConfig | null {
  if (!option) return null;
  if (option === true) {
    return {
      clicks: true,
      submits: true,
      scroll: true,
      rageClicks: true,
      deadClicks: true,
      captureTextContent: false,
      blockSelectors: [],
      scrollCheckpoints: DEFAULT_CHECKPOINTS,
    };
  }
  return {
    clicks: option.clicks ?? true,
    submits: option.submits ?? true,
    scroll: option.scroll ?? true,
    rageClicks: option.rageClicks ?? true,
    deadClicks: option.deadClicks ?? true,
    captureTextContent: option.captureTextContent ?? false,
    blockSelectors: option.blockSelectors ?? [],
    scrollCheckpoints:
      option.scrollCheckpoints && option.scrollCheckpoints.length > 0
        ? option.scrollCheckpoints
        : DEFAULT_CHECKPOINTS,
  };
}

function isBlocked(el: Element, blockSelectors: string[]): boolean {
  // Match selectors one by one so a single malformed selector cannot disable
  // the valid ones.
  for (const selector of blockSelectors) {
    try {
      if (el.closest(selector) !== null) return true;
    } catch {
      // invalid selector: ignore it, keep checking the rest
    }
  }
  return false;
}

function classList(el: Element): string[] {
  return Array.from(el.classList);
}

/** Build `$mp_click` props for an interactive element (never input values). */
function clickProps(el: Element, captureText: boolean): Record<string, unknown> {
  const tag = el.tagName.toLowerCase();
  const props: Record<string, unknown> = {
    $el_tag_name: tag,
    $el_classes: classList(el),
  };
  if (el.id) props.$el_id = el.id;
  if (tag === "a") {
    const href = (el as HTMLAnchorElement).getAttribute("href");
    if (href) props.$el_href = href;
  }
  if (captureText && tag !== "input") {
    const text = (el.textContent ?? "").trim();
    if (text) props.$el_text = text.slice(0, MAX_TEXT_LENGTH);
  }
  return props;
}

type TrackFn = (event: string, properties?: Record<string, unknown>) => void;

/** Handle returned by setupAutocapture: reset scroll checkpoints, or tear everything down. */
export interface AutocaptureHandle {
  /** Reset fired scroll checkpoints (call on SPA navigation). */
  resetScroll(): void;
  /** Remove all listeners. */
  teardown(): void;
}

/**
 * Attach opt-in autocapture listeners. Returns null (no-op) when disabled or
 * during SSR. Otherwise returns a handle to reset scroll state on navigation
 * and to tear listeners down.
 */
export function setupAutocapture(
  track: TrackFn,
  option: AutocaptureOption | undefined,
): AutocaptureHandle | null {
  const config = resolveConfig(option);
  if (!config) return null;
  if (typeof window === "undefined" || typeof document === "undefined") return null;

  const cleanups: (() => void)[] = [];
  const firedCheckpoints = new Set<number>();

  if (config.clicks || config.rageClicks || config.deadClicks) {
    // Recent non-blocked click positions, used for rage-click clustering.
    let recentClicks: { x: number; y: number; t: number }[] = [];
    // In-flight dead-click checks so teardown can cancel pending timers/observers.
    const pendingDeadChecks = new Set<{
      timer: ReturnType<typeof setTimeout> | undefined;
      observer: MutationObserver;
    }>();

    const detectRageClick = (
      x: number,
      y: number,
      props: Record<string, unknown>,
    ) => {
      const now = Date.now();
      // Keep only recent clicks clustered near this one.
      recentClicks = recentClicks.filter(
        (c) =>
          now - c.t <= RAGE_WINDOW_MS &&
          Math.hypot(c.x - x, c.y - y) <= RAGE_RADIUS_PX,
      );
      recentClicks.push({ x, y, t: now });
      if (recentClicks.length >= RAGE_MIN_CLICKS) {
        track("$mp_rage_click", props);
        recentClicks = []; // fire once per burst
      }
    };

    const detectDeadClick = (props: Record<string, unknown>) => {
      let mutated = false;
      const startUrl =
        typeof location !== "undefined" ? location.href : undefined;
      const observer = new MutationObserver(() => {
        mutated = true;
      });
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const check: {
        timer: ReturnType<typeof setTimeout> | undefined;
        observer: MutationObserver;
      } = { timer: undefined, observer };
      check.timer = setTimeout(() => {
        observer.disconnect();
        pendingDeadChecks.delete(check);
        const navigated =
          typeof location !== "undefined" && location.href !== startUrl;
        if (!mutated && !navigated) track("$mp_dead_click", props);
      }, DEAD_CLICK_TIMEOUT_MS);
      pendingDeadChecks.add(check);
    };

    const onClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Prefer the closest interactive element for props; fall back to the raw
      // target so rage clicks on non-interactive elements are still captured.
      const interactive = target.closest(CLICK_SELECTOR);
      const el = interactive ?? target;
      if (isBlocked(el, config.blockSelectors)) return;
      const props = clickProps(el, config.captureTextContent);

      if (config.clicks && interactive) track("$mp_click", props);
      if (config.rageClicks) {
        const me = event as MouseEvent;
        detectRageClick(me.clientX ?? 0, me.clientY ?? 0, props);
      }
      // Dead clicks only make sense on interactive-looking elements.
      if (config.deadClicks && interactive) detectDeadClick(props);
    };
    document.addEventListener("click", onClick, true);
    cleanups.push(() => {
      document.removeEventListener("click", onClick, true);
      for (const check of pendingDeadChecks) {
        clearTimeout(check.timer);
        check.observer.disconnect();
      }
      pendingDeadChecks.clear();
    });
  }

  if (config.submits) {
    const onSubmit = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const form = target.closest("form");
      if (!form) return;
      if (isBlocked(form, config.blockSelectors)) return;
      const props: Record<string, unknown> = {
        $el_tag_name: "form",
        $el_classes: classList(form),
      };
      if (form.id) props.$el_id = form.id;
      track("$mp_submit", props);
    };
    document.addEventListener("submit", onSubmit, true);
    cleanups.push(() => document.removeEventListener("submit", onSubmit, true));
  }

  if (config.scroll) {
    const checkpoints = [...config.scrollCheckpoints].sort((a, b) => a - b);
    const onScroll = () => {
      if (firedCheckpoints.size === checkpoints.length) return;
      const doc = document.documentElement;
      const scrollTop = window.scrollY ?? doc.scrollTop ?? 0;
      const viewport = window.innerHeight || doc.clientHeight || 0;
      const full = doc.scrollHeight || 0;
      const scrollable = full - viewport;
      const depth =
        scrollable <= 0 ? 100 : Math.min(100, ((scrollTop + viewport) / full) * 100);
      for (const checkpoint of checkpoints) {
        if (depth >= checkpoint && !firedCheckpoints.has(checkpoint)) {
          firedCheckpoints.add(checkpoint);
          track("$mp_scroll", { $scroll_depth_percent: checkpoint });
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    cleanups.push(() => window.removeEventListener("scroll", onScroll));
  }

  return {
    resetScroll() {
      firedCheckpoints.clear();
    },
    teardown() {
      for (const fn of cleanups) fn();
    },
  };
}
