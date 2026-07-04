# @cohorly/react-native

Standalone React Native client for Cohorly (local, Mixpanel-style product analytics). No hard
dependency on `react-native` or any storage library - it works out of the box with an in-memory
store, and upgrades to persistent storage when you inject one.

## Install

```bash
pnpm add @cohorly/react-native
# recommended, for persistence across app restarts
pnpm add @react-native-async-storage/async-storage
```

## Usage

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { init, track, identify, register, people } from "@cohorly/react-native";

init({
  apiHost: "http://localhost:4000",
  // Project token: stamped on every tracked event's properties and included
  // as a top-level `token` field on every /engage body.
  token: "YOUR_PROJECT_TOKEN",
  storage: AsyncStorage, // injects real persistence; falls back to in-memory if omitted
});

register({ app_version: "1.2.0" });

track("Screen Viewed", { screen: "Home" });

identify("user_123");
people.set({ plan: "pro" });
```

### Injecting AsyncStorage

This package has no hard dependency on `react-native` or any storage library - the
`storage` option accepts anything matching the minimal `AsyncStorageLike` interface
(`getItem`/`setItem`/`removeItem`, matching `@react-native-async-storage/async-storage`'s
default export shape 1:1). Install it separately and pass it straight through:

```bash
pnpm add @react-native-async-storage/async-storage
```

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { init } from "@cohorly/react-native";

init({ apiHost: "http://localhost:4000", storage: AsyncStorage });
```

Without `storage`, the client falls back to `InMemoryStorage` (also exported from this
package), which works but loses the distinct id, queued events, and super properties on
every app restart.

Events are queued and flushed automatically every 5 seconds or once 20 events have
accumulated (both configurable via `flushInterval` / `flushAt`). Queued events are persisted
to storage, so nothing is lost if the app closes before a flush.

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `init` | `(options: CohorlyOptions) => CohorlyClient` | `apiHost` required; `token`, `storage`, `flushInterval`, `flushAt`, `fetch`, `disabled` optional. |
| `track` | `(event, properties?) => void` | |
| `identify` | `(distinctId: string) => void` | Local only - no `/alias` call from this package. |
| `reset` | `() => void` | Clears identity, super properties, and un-flushed events. |
| `register` / `unregister` | `(props) => void` / `(key) => void` | Super properties merged into every event. |
| `people.set/setOnce/increment/unset/deleteUser` | see source | Queued and sent to `/engage`. |
| `flush` | `() => Promise<void>` | Manual flush. |
| `getDistinctId` | `() => string` | |

You can also construct `new CohorlyClient(options)` directly instead of using the module-level
singleton, e.g. for multiple instances or dependency injection in tests.

### `token`

Pass `token` to `init()` (or the `CohorlyClient` constructor) to stamp your Cohorly
project token on every tracked event's properties and as a top-level `token` field on
every `/engage` payload sent by `people.*`.

## Testing

```bash
pnpm test
```

Unit tests use fake storage and a fake `fetch` transport to cover payload shape, batching /
auto-flush (both size and interval triggered), retry-on-failure, and identify/reset persistence.
