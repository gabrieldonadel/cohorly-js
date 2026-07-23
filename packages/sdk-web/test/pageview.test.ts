import { describe, expect, it } from "vitest";
import { PAGEVIEW_EVENT, getPageviewProperties } from "../src/pageview.js";

describe("pageview", () => {
  it("uses the Mixpanel-compatible event name", () => {
    expect(PAGEVIEW_EVENT).toBe("$mp_web_page_view");
  });

  it("returns page props derived from location/document", () => {
    document.title = "My Page";
    const props = getPageviewProperties();
    expect(props.$current_url).toBe(location.href);
    expect(props.current_domain).toBe(location.hostname);
    expect(props.current_url_path).toBe(location.pathname);
    expect(props.current_url_search).toBe(location.search);
    expect(props.current_page_title).toBe("My Page");
  });
});
