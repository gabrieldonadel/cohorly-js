import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupAutocapture } from "../src/autocapture.js";

describe("setupAutocapture", () => {
  let handle: ReturnType<typeof setupAutocapture>;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    handle?.teardown();
    handle = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("is a no-op (returns null) when disabled", () => {
    expect(setupAutocapture(vi.fn(), undefined)).toBeNull();
    expect(setupAutocapture(vi.fn(), false)).toBeNull();
  });

  it("captures $mp_click on interactive elements with tag/id/classes/href", () => {
    document.body.innerHTML =
      '<a id="cta" class="btn primary" href="/signup">Sign up now</a>';
    const track = vi.fn();
    handle = setupAutocapture(track, true);
    document.getElementById("cta")!.click();

    expect(track).toHaveBeenCalledTimes(1);
    const [event, props] = track.mock.calls[0];
    expect(event).toBe("$mp_click");
    expect(props.$el_tag_name).toBe("a");
    expect(props.$el_id).toBe("cta");
    expect(props.$el_classes).toEqual(["btn", "primary"]);
    expect(props.$el_href).toBe("/signup");
    // captureTextContent defaults off
    expect(props.$el_text).toBeUndefined();
  });

  it("captures $el_text (trimmed, capped) only when captureTextContent", () => {
    const long = "x".repeat(300);
    document.body.innerHTML = `<button id="b">  ${long}  </button>`;
    const track = vi.fn();
    handle = setupAutocapture(track, { captureTextContent: true });
    document.getElementById("b")!.click();
    const props = track.mock.calls[0][1];
    expect(props.$el_text).toHaveLength(255);
  });

  it("never captures input values", () => {
    document.body.innerHTML =
      '<input id="s" type="submit" value="secret-value" />';
    const track = vi.fn();
    handle = setupAutocapture(track, { captureTextContent: true });
    document.getElementById("s")!.click();
    const props = track.mock.calls[0][1];
    expect(JSON.stringify(props)).not.toContain("secret-value");
    expect(props.$el_text).toBeUndefined();
  });

  it("respects blockSelectors", () => {
    document.body.innerHTML =
      '<div class="no-track"><button id="b">Hi</button></div>';
    const track = vi.fn();
    handle = setupAutocapture(track, { blockSelectors: [".no-track"] });
    document.getElementById("b")!.click();
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores clicks outside interactive elements", () => {
    document.body.innerHTML = "<span id=\"plain\">text</span>";
    const track = vi.fn();
    handle = setupAutocapture(track, true);
    document.getElementById("plain")!.click();
    expect(track).not.toHaveBeenCalled();
  });

  it("captures $mp_submit with form tag/id/classes and no field values", () => {
    document.body.innerHTML =
      '<form id="login" class="auth"><input name="password" value="hunter2" /></form>';
    const track = vi.fn();
    handle = setupAutocapture(track, true);
    const form = document.getElementById("login") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const call = track.mock.calls.find((c) => c[0] === "$mp_submit");
    expect(call).toBeTruthy();
    expect(call![1].$el_tag_name).toBe("form");
    expect(call![1].$el_id).toBe("login");
    expect(call![1].$el_classes).toEqual(["auth"]);
    expect(JSON.stringify(call![1])).not.toContain("hunter2");
  });

  const clickAt = (el: Element, x: number, y: number) =>
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }),
    );

  it("fires $mp_rage_click once on 4+ rapid clicks in the same spot", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">x</button>';
    const track = vi.fn();
    handle = setupAutocapture(track, { clicks: false, deadClicks: false });
    const btn = document.getElementById("b")!;

    clickAt(btn, 10, 10);
    clickAt(btn, 12, 10);
    clickAt(btn, 11, 12);
    expect(track.mock.calls.filter((c) => c[0] === "$mp_rage_click")).toHaveLength(0);

    clickAt(btn, 13, 11); // 4th click within 30px -> rage
    const rage = track.mock.calls.filter((c) => c[0] === "$mp_rage_click");
    expect(rage).toHaveLength(1);
    expect(rage[0][1].$el_tag_name).toBe("button");
    expect(rage[0][1].$el_id).toBe("b");

    // Fires once per burst: a 5th click does not immediately re-fire.
    clickAt(btn, 13, 11);
    expect(track.mock.calls.filter((c) => c[0] === "$mp_rage_click")).toHaveLength(1);
  });

  it("does not fire $mp_rage_click when clicks are spread apart", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">x</button>';
    const track = vi.fn();
    handle = setupAutocapture(track, { clicks: false, deadClicks: false });
    const btn = document.getElementById("b")!;
    clickAt(btn, 0, 0);
    clickAt(btn, 100, 0);
    clickAt(btn, 200, 0);
    clickAt(btn, 300, 0);
    expect(track.mock.calls.filter((c) => c[0] === "$mp_rage_click")).toHaveLength(0);
  });

  it("fires $mp_dead_click when a click causes no DOM change", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">x</button>';
    const track = vi.fn();
    handle = setupAutocapture(track, { clicks: false, rageClicks: false });
    clickAt(document.getElementById("b")!, 5, 5);
    vi.advanceTimersByTime(500);
    const dead = track.mock.calls.filter((c) => c[0] === "$mp_dead_click");
    expect(dead).toHaveLength(1);
    expect(dead[0][1].$el_id).toBe("b");
  });

  it("does not fire $mp_dead_click when the DOM mutates after the click", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">x</button>';
    const track = vi.fn();
    handle = setupAutocapture(track, { clicks: false, rageClicks: false });
    clickAt(document.getElementById("b")!, 5, 5);
    // Simulate a live handler mutating the DOM.
    document.body.appendChild(document.createElement("div"));
    await Promise.resolve(); // flush the MutationObserver microtask
    vi.advanceTimersByTime(500);
    expect(track.mock.calls.filter((c) => c[0] === "$mp_dead_click")).toHaveLength(0);
  });

  it("does not fire $mp_dead_click on non-interactive elements", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span id="s">plain</span>';
    const track = vi.fn();
    handle = setupAutocapture(track, { clicks: false, rageClicks: false });
    clickAt(document.getElementById("s")!, 5, 5);
    vi.advanceTimersByTime(500);
    expect(track.mock.calls.filter((c) => c[0] === "$mp_dead_click")).toHaveLength(0);
  });

  it("fires $mp_scroll once per checkpoint and resets on navigation", () => {
    const track = vi.fn();
    handle = setupAutocapture(track, { clicks: false, submits: false });

    // jsdom has no layout; force a scrollable document.
    Object.defineProperty(document.documentElement, "scrollHeight", {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "scrollY", { value: 700, configurable: true });

    window.dispatchEvent(new Event("scroll"));
    // depth = (700+800)/2000 = 75% -> checkpoints 25,50,75 fire
    let depths = track.mock.calls
      .filter((c) => c[0] === "$mp_scroll")
      .map((c) => c[1].$scroll_depth_percent);
    expect(depths).toEqual([25, 50, 75]);

    // second scroll to same depth: no new events
    window.dispatchEvent(new Event("scroll"));
    depths = track.mock.calls
      .filter((c) => c[0] === "$mp_scroll")
      .map((c) => c[1].$scroll_depth_percent);
    expect(depths).toEqual([25, 50, 75]);

    // reset + scroll again -> checkpoints fire again
    handle!.resetScroll();
    window.dispatchEvent(new Event("scroll"));
    depths = track.mock.calls
      .filter((c) => c[0] === "$mp_scroll")
      .map((c) => c[1].$scroll_depth_percent);
    expect(depths).toEqual([25, 50, 75, 25, 50, 75]);
  });
});
