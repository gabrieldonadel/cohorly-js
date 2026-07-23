# @cohorly/web

Browser SDK for Cohorly (hosted, Mixpanel-style product analytics). Built on
`@cohorly/core` with localStorage persistence, `fetch`/`sendBeacon` transport (so events
survive tab close/navigation), and optional SPA pageview autotracking.

## Install

```bash
pnpm add @cohorly/web
# or: npm install @cohorly/web / yarn add @cohorly/web
```

## Quickstart

```ts
import { init } from "@cohorly/web";

const cohorly = init({
  // Project token: attached to every event and to every /engage & /alias body.
  token: "YOUR_PROJECT_TOKEN",
  trackPageviews: true,
  // apiHost defaults to the hosted Cohorly API; set it to target a different deployment.
});

cohorly.track("Signed Up", { plan: "pro" });
await cohorly.identify("user_123");
await cohorly.people.set({ name: "Ada Lovelace" });
```

Or use the named singleton after `init()` has run once (e.g. app entry point):

```ts
import { cohorly } from "@cohorly/web";

cohorly.track("Button Clicked", { button: "checkout" });
```

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `init` | `(options: CohorlyWebOptions) => Cohorly` | All optional: `apiHost` (defaults to the hosted API), `token`, `flushIntervalMs`, `batchSize`, `debug`, `trackPageviews`, `autocapture`, `superProperties`. |
| `cohorly.track` | `(event, properties?) => void` | Merges in device (`$browser`/`$browser_version`/`$os`/`$device`/`$screen_*`/`$lib_version`), `$current_url`, and attribution (`$referrer`/`$referring_domain`/`$initial_*`/`$search_engine`/`mp_keyword`) props automatically. |
| `cohorly.identify` | `(id: string) => Promise<void>` | |
| `cohorly.reset` | `() => void` | |
| `cohorly.register` / `unregister` | `(props) => void` / `(key) => void` | Super properties. |
| `cohorly.timeEvent` | `(event) => void` | Start a timer; next `track(event)` attaches `$duration` (seconds). See `clearTimedEvent` / `clearTimedEvents`. |
| `cohorly.people.*` | `set/setOnce/increment/unset/delete` | Profile updates. `set`/`setOnce` auto-merge platform profile defaults (see below). `unset`/`delete` are destructive and refused by the server on the public project token alone (they need an org-owner/superadmin `Authorization` credential the browser SDK does not have) - server-side no-ops here; use the dashboard or the admin privacy API. |
| `cohorly.flush` | `() => Promise<void>` | Manual flush. |
| `cohorly.getDistinctId` / `isAnonymous` | - | Accessors. |

Safe to call `init()` during SSR: browser-only APIs (localStorage, `window`,
`sendBeacon`) fall back to in-memory/no-op implementations when unavailable.

## Default & attribution properties

Every event automatically carries Mixpanel-compatible props:

- **Device**: `$browser`, `$browser_version`, `$os`, `$device` (mobile only),
  `$screen_width`, `$screen_height`, `$lib_version`, `$current_url`.
- **Attribution**: `$referrer`, `$referring_domain`, `$search_engine` +
  `mp_keyword` (google/bing/yahoo/duckduckgo referrers), and first-touch
  `$initial_referrer` / `$initial_referring_domain` (persisted once, defaulting
  to `$direct`).
- **Identity**: `$device_id` (stable per-browser, survives `identify()`) on every
  event, and `$user_id` (the identified distinct id) once `identify()` has run.
- **Campaign**: any UTM params (`utm_source/medium/campaign/term/content`),
  `utm_id`, and ad click IDs (`dclid`, `fbclid`, `gclid`, `gbraid`, `wbraid`,
  `ko_click_id`, `li_fat_id`, `msclkid`, `sccid`, `ttclid`, `twclid`) present in
  the landing URL are registered as super properties on `init()`.

On first ever visit, a one-time `$set_once` profile update records
`$initial_referrer`, `$initial_referring_domain`, and `initial_<campaign param>`
(e.g. `initial_utm_source`, `initial_gclid`).

### Profile defaults

`people.set` / `people.setOnce` auto-merge platform profile defaults (Mixpanel
parity) so profiles carry `$os`, `$browser`, `$browser_version`,
`$initial_referrer`, and `$initial_referring_domain`. Keys you pass explicitly
always win.

## Automatic pageviews

With `trackPageviews: true`, a `$mp_web_page_view` event fires on init and on SPA
route changes (history `pushState`/`replaceState`/`popstate`) with props
`$current_url`, `current_page_title`, `current_domain`, `current_url_path`,
`current_url_search`.

## Autocapture (opt-in)

`autocapture` is off by default. Pass `true` for all handlers, or an object to
tune them:

```ts
init({
  token: "YOUR_PROJECT_TOKEN",
  autocapture: {
    clicks: true,           // $mp_click on a/button/[role=button]/input[button|submit]
    submits: true,          // $mp_submit on form submit
    scroll: true,           // $mp_scroll at depth checkpoints
    rageClicks: true,       // $mp_rage_click on 4+ clicks in 1s within 30px
    deadClicks: true,       // $mp_dead_click: interactive click, no DOM change/nav in 500ms
    captureTextContent: false,       // $el_text only when true (trimmed, <=255 chars)
    blockSelectors: [".sensitive"],  // element.closest() match -> skip
    scrollCheckpoints: [25, 50, 75, 100],
  },
});
```

Captured click props: `$el_tag_name`, `$el_id`, `$el_classes` (array), `$el_href`
(anchors only), and `$el_text` (only with `captureTextContent`). Submit props:
`$el_tag_name: "form"`, `$el_id`, `$el_classes`. Scroll prop:
`$scroll_depth_percent`, fired once per checkpoint per page and reset on SPA
navigation. **Input values are never captured.**

`rageClicks` and `deadClicks` default **on** when autocapture is enabled (set
either to `false` to disable). `$mp_rage_click` fires once per burst of 4+ clicks
within 1s in a 30px radius. `$mp_dead_click` fires when a click on an interactive
element (`a`/`button`/`[role=button]`/`input[button|submit]`) triggers no DOM
mutation and no navigation within 500ms. Both carry the same `$el_*` props as
`$mp_click`.

## `token`

Pass `token` to `init()` to stamp your Cohorly project token on every tracked event and
every `/engage`/`/alias` request body. If you'd rather keep the token out of the client
bundle entirely, proxy ingestion through `@cohorly/nextjs`'s `createCohorlyProxy({ token })`
server-side mode instead and omit `token` here.

## Delivery and retries

Events are queued in `localStorage` (in-memory fallback during SSR) and never
dropped on a transient failure. The SDK inherits the `@cohorly/core` retry
contract:

- **429** keeps the queue and backs off, honoring the server's `Retry-After`.
- **5xx / network** keeps the queue with exponential backoff (base 2000ms,
  doubling, capped at `maxRetryDelayMs`, +/-20% jitter).
- **413** halves the effective batch size and retries smaller (no data loss).
- **400** drops the offending batch (it will never succeed).
- **401** keeps the queue and backs off at the max delay.

The persisted queue is capped at `maxQueueSize` (default 1000), dropping the
oldest events on overflow. Pass `maxQueueSize` / `maxRetryDelayMs` to `init()` to
tune these. On page hide / tab close the queue is flushed via `navigator.sendBeacon`
(best effort, fire-and-forget).
