# @cohorly/web

Browser SDK for Cohorly (local, self-hosted, Mixpanel-style product analytics). Built on
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
  apiHost: "https://your-cohorly-server.example.com",
  // Project token: attached to every event and to every /engage & /alias body.
  token: "YOUR_PROJECT_TOKEN",
  trackPageviews: true,
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
| `init` | `(options: CohorlyWebOptions) => Cohorly` | `apiHost` required; `token`, `flushIntervalMs`, `batchSize`, `debug`, `trackPageviews`, `superProperties` optional. |
| `cohorly.track` | `(event, properties?) => void` | Merges in `$browser`/`$os`/`$current_url`/screen size automatically. |
| `cohorly.identify` | `(id: string) => Promise<void>` | |
| `cohorly.reset` | `() => void` | |
| `cohorly.register` / `unregister` | `(props) => void` / `(key) => void` | Super properties. |
| `cohorly.people.*` | `set/setOnce/increment/unset/delete` | Profile updates. |
| `cohorly.flush` | `() => Promise<void>` | Manual flush. |
| `cohorly.getDistinctId` / `isAnonymous` | - | Accessors. |

Safe to call `init()` during SSR: browser-only APIs (localStorage, `window`,
`sendBeacon`) fall back to in-memory/no-op implementations when unavailable.

## `token`

Pass `token` to `init()` to stamp your Cohorly project token on every tracked event and
every `/engage`/`/alias` request body. If you'd rather keep the token out of the client
bundle entirely, proxy ingestion through `@cohorly/nextjs`'s `createCohorlyProxy({ token })`
server-side mode instead and omit `token` here.
