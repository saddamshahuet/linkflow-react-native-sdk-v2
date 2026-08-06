# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-08-05

Vendored native sources updated to Android SDK 2.0.0 and iOS SDK 2.0.0. See
those changelogs for the full set of attribution fixes; the highlights are that
Android deterministic attribution (Play Install Referrer) and iOS identifier
reporting both work now, and neither did before.

### Fixed
- **`handleDeepLink` was a no-op on Android.** The bridge emitted the JS event
  directly with a comment noting the Android SDK had no public deep-link entry
  point, so JS-side deep link handling silently did nothing on Android while
  working on iOS. It now routes through the SDK, which has one.
- `getAttributionResult()` falls back to the native SDK's persisted result, so a
  JS reload — which clears the bridge module's in-memory cache — no longer
  returns `null` for an install that was attributed.
- `npm test` could never run: the package declared a Jest config but shipped no
  Babel config, so any test file failed to transform. Added `babel.config.js`.

### Added
- `appKey`, `requireConsent` and `collectAdvertisingId` in `LinkFlowConfig`,
  passed through to both native SDKs.
- `LinkFlow.setConsent({ attribution, advertisingId })` for GDPR/DMA/CCPA
  gating. Launches requested before consent are buffered and replayed.
- `LinkFlow.pendingEventCount()` — depth of the native offline event queue.
- `AttributionResult` now carries `attributionMethod`, `confidence` and
  `isReinstall`, with an exported `AttributionMethod` union type.
- Jest tests covering the native bridge contract.

### Deprecated
- `setAttributionCallback(callback)` remains available. The 1.1.0 changelog
  slated it for removal in 2.0.0; that is deferred to 3.0.0 so this release
  stays a drop-in fix for attribution rather than a source-breaking change.

## [1.1.0] - 2026-05-02

### Added
- **Zero-config native integration**: vendored canonical iOS Swift and Android Kotlin source inside the package; consumers no longer need a separate CocoaPod or Maven dependency. Native autolinking handles iOS (`pod install`) and Android (Gradle).
- New listener-based JS API: `addAttributionListener(cb) -> EmitterSubscription`, `addDeepLinkListener(cb)`, `addErrorListener(cb)`. Returned subscriptions must be cleaned up with `.remove()`.
- iOS bridge (`ios/LinkFlowSDKModule.swift`): `RCTEventEmitter` with cached last `AttributionResult`.
- Android bridge (`android/src/main/kotlin/com/linkflow/sdk/rn/LinkFlowSDKModule.kt`): `ReactContextBaseJavaModule` with cached last result and emit guards.
- `LinkFlowSDK.podspec` at repo root with `install_modules_dependencies` / `React-Core` fallback.
- `react-native.config.js` autolinking config.

### Changed
- `src/index.tsx`: rewritten for leak-free listener management via internal subscription handle; stricter `assertInitialized` guards.

### Deprecated
- `setAttributionCallback(callback)` — kept as a back-compat shim. Use `addAttributionListener` instead. Will be removed in 2.0.0.

## [1.0.2] - 2024-12-01

### Added
- Initial standalone release extracted from main LinkFlow repository
- Full TypeScript support with bundled declaration files
- `useAttribution` React hook for functional components
- Cross-platform attribution resolution (iOS/Android)
- In-app event tracking with revenue support
- Deep link handling via native bridge
- Configurable API base URL and logging

### Fixed
- Improved error handling for native module bridge failures

## [1.0.1] - 2024-11-15

### Fixed
- TypeScript type exports for `AttributionResult`

## [1.0.0] - 2024-11-01

### Added
- Initial release
- React Native bridge to native iOS/Android SDKs
- Attribution callback system
- Event tracking API
- Deep link listener
