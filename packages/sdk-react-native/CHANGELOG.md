# @cohorly/react-native

## 1.1.3

### Patch Changes

- 9d06dd2: Server behavior change: the destructive `/engage` verbs `$unset` and `$delete`
  (`people.unset` / `people.delete` / `people.delete_user` / `deleteUser`) are no
  longer honored when a request is authenticated only by the project token, which
  ships in public client bundles. They now require an org-owner or superadmin
  `Authorization: Bearer` credential on the same request. Refused ops are skipped
  individually - the rest of the batch still applies - and the server keeps
  answering HTTP 200 with `{ status: 0, error, applied, refused: [{ index, op }] }`,
  so SDK retry queues are not wedged. From these SDKs (which send only the project
  token) the destructive calls become server-side no-ops; remove profile data from
  the dashboard or via `DELETE /api/privacy/subjects/:distinctId` (audited).
  `set` / `set_once` / `increment` ($add) are unaffected. No SDK code changed;
  docs and type annotations updated.

## 1.1.2

### Patch Changes

- a5ba8cc: Fix `$lib_version` reporting: the `src/version.ts` constants had drifted from
  package.json (stuck at 0.1.0) because releases only bumped package.json. The
  constants are now corrected and kept in sync automatically at release time.

## 1.1.1

### Patch Changes

- 0a7559e: Move `CohorlyReactNative.podspec` to the package root and fix `react-native.config.js` to export the standard self-describing `dependency` key (was `dependencies` keyed by the package's own name, the app-override shape).

  Both Expo's built-in autolinking (`expo-modules-autolinking`) and the classic community CLI only discover a native iOS module's podspec via a non-recursive scan of the package root, and only read a library's own `dependency` config when its own name isn't found there - so with the podspec nested under `ios/` and the config keyed under `dependencies`, the native module silently failed to link in any Expo-prebuild consumer (verified against monoriders), even though the pure-JS SDK worked fine. This matches the convention used by `react-native-mmkv`, `react-native-reanimated`, and other widely-used libraries.

## 1.1.0

### Minor Changes

- c09f00b: Auto-capture device/app properties (`$app_version_string`, `$app_build_number`, `$model`, `$manufacturer`, `$brand`, `$carrier`) via a bundled native module, with fallback to `react-native-device-info` or `expo-device`/`expo-application` when the native module isn't linked.
- 219627e: Reposition the SDKs as hosted SaaS instead of a local self-hosted project, and
  make the ingestion host zero-config.

  - Descriptions, README intros, and examples now describe Cohorly as hosted
    product analytics.
  - `apiHost` is now optional across the client SDKs and defaults to the hosted
    endpoint (`https://cohorly-service.velloalabs.com`); the server-side default
    ingestion host moved off `http://localhost:4000` too. Existing callers that
    pass `apiHost` are unaffected.
