# @cohorly/core

Transport-agnostic core client for Cohorly (local, self-hosted, Mixpanel-style product
analytics). Handles the event queue, batching, flush scheduling, identity, and super
properties. Storage and network transport are injected by platform SDKs, so this package
has zero DOM/Node/React Native dependencies and can be used to build a new platform SDK.

Most apps should use a platform package instead of this one directly:
`@cohorly/web`, `@cohorly/react`, `@cohorly/nextjs`, `@cohorly/react-native`, or the iOS
`CohorlySwift` package.

## Install

```bash
pnpm add @cohorly/core
# or: npm install @cohorly/core / yarn add @cohorly/core
```

## Quickstart

```ts
import { CohorlyClient, fetchTransport } from "@cohorly/core";
import type { CohorlyStorage } from "@cohorly/core";

const storage: CohorlyStorage = {
  get: (key) => myStore.get(key) ?? null,
  set: (key, value) => myStore.set(key, value),
  remove: (key) => myStore.delete(key),
};

const client = new CohorlyClient({
  apiHost: "https://your-cohorly-server.example.com",
  // Project token: attached to every tracked event's properties and to every
  // /engage and /alias body, so the server can route data to your project.
  token: "YOUR_PROJECT_TOKEN",
  storage,
  transport: fetchTransport, // or a custom CohorlyTransport
});

client.track("Signed Up", { plan: "pro" });
await client.identify("user_123");
await client.people.set({ name: "Ada Lovelace" });
```

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `new CohorlyClient(options)` | `CohorlyClientOptions` | `apiHost`, `storage`, and optionally `transport`, `token`, `flushIntervalMs`, `batchSize`, `debug`, `lib`. |
| `track` | `(event: string, properties?) => TrackedEvent` | Enqueues an event; auto-flushes at `batchSize`. |
| `identify` | `(id: string) => Promise<void>` | Switches distinct id; sends `/alias` the first time if previously anonymous. |
| `reset` | `() => void` | Assigns a fresh anonymous distinct id. |
| `register` / `unregister` | `(props) => void` / `(key: string) => void` | Super properties merged into every event. |
| `people.set/setOnce/increment/unset/delete` | see `PeopleProperties` | Profile updates sent to `/engage`. |
| `flush` | `(transportOverride?) => Promise<void>` | Manually flush the queue. |
| `getDistinctId` / `isAnonymous` / `getApiHost` | - | Accessors. |
| `stop` | `() => void` | Stops the auto-flush timer. |

### `token`

When `options.token` is set, it is:
- stamped as `properties.token` on every event passed to `track()`,
- included as a top-level `token` field on every `/engage` body (via `people.*`),
- included as a top-level `token` field on the `/alias` body sent by `identify()`.

Omit it if your deployment doesn't use per-project tokens.

## Testing

```bash
pnpm test
```
