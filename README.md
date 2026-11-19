# LinkFlow React Native SDK

Production-ready React Native SDK for mobile attribution and deep linking.

## Features

| Feature | Description |
|---|---|
| **Deferred Deep Linking** | Routes users to specific in-app content after install, even when the app was not present at click time |
| **Universal Links & App Links** | Native iOS Universal Links and Android App Links for seamless, browser-free handoff |
| **Custom URL Schemes** | Full support for custom URI scheme handling as a reliable fallback |
| **Install Attribution** | Deterministic and probabilistic attribution to match installs back to the originating click |
| **In-App Event Tracking** | Track post-install events and revenue to measure campaign performance end-to-end |
| **Cross-Platform API** | A unified JavaScript API that works identically on iOS and Android |
| **TypeScript** | Fully typed with bundled declaration files — no `@types` package required |
| **React Hooks** | `useAttribution` hook for ergonomic integration into functional components |

## Installation

```bash
npm install @linkflow/react-native-sdk
# or
yarn add @linkflow/react-native-sdk
```

The SDK is **zero-config**: native iOS and Android source is shipped inside
the package and wired up via React Native autolinking. There is no separate
CocoaPod or Maven dependency to add.

### iOS Setup

```bash
cd ios && pod install
```

Add to `Info.plist` (only if your app requests App Tracking Transparency; the SDK never shows the prompt):
```xml
<key>NSUserTrackingUsageDescription</key>
<string>We use tracking to measure ad performance</string>
```

### Android Setup

No additional setup required — the module autolinks. Standard React Native
rebuild (`./gradlew clean && yarn android`) is enough.

## Quick Start

### 1. Initialize SDK

```typescript
import LinkFlow from '@linkflow/react-native-sdk';
import { useEffect } from 'react';

function App() {
  useEffect(() => {
    let mounted = true;

    (async () => {
      await LinkFlow.initialize({
        apiBaseURL: 'https://thelinkflow.app',
        enableLogging: __DEV__
      });
      if (mounted) await LinkFlow.handleAppLaunch();
    })();

    const attribSub = LinkFlow.addAttributionListener((result) => {
      if (result.attributed && result.deepLinkValue?.includes('product')) {
        navigation.navigate('Product', { ...result.deepLinkParams });
      }
    });

    const deepLinkSub = LinkFlow.addDeepLinkListener(({ url }) => {
      console.log('[LinkFlow] deep link received:', url);
    });

    const errorSub = LinkFlow.addErrorListener((err) => {
      console.warn('[LinkFlow] error:', err.message);
    });

    return () => {
      mounted = false;
      attribSub.remove();
      deepLinkSub.remove();
      errorSub.remove();
      LinkFlow.destroy();
    };
  }, []);

  return <YourApp />;
}
```

### 2. Track Events

```typescript
import LinkFlow from '@linkflow/react-native-sdk';

// Track purchase
await LinkFlow.trackEvent('purchase', {
  order_id: '12345',
  currency: 'USD'
}, 99.99);

// Track product view
await LinkFlow.trackEvent('product_view', {
  product_id: 'abc123'
});
```

### 3. Handle Deep Links

The SDK auto-bridges `Linking` events to native and re-emits them as
`LinkFlowDeepLink`. Subscribe with `addDeepLinkListener`:

```typescript
const sub = LinkFlow.addDeepLinkListener(({ url }) => {
  const u = new URL(url);
  if (u.pathname.startsWith('/product/')) {
    const productId = u.pathname.split('/').pop();
    navigation.navigate('Product', { id: productId });
  }
});
// later:
sub.remove();
```

## What's new in 2.2

```ts
// Hold deep links while splash / onboarding / login is showing. Call this before initialize()
// so that even the first deferred link is held.
await LinkFlow.holdDeepLinks();
// ...then deliver what arrived meanwhile (latest per kind), once the app can navigate:
await LinkFlow.releaseDeepLinks();

// How the server matched the install (absent with older servers):
const result = await LinkFlow.getAttributionResult();
result?.match?.method; // 'install_referrer' | 'click_token' | 'advertising_id' | 'probabilistic' | 'organic'

// Support snapshot: no identifiers or personal data.
console.log(await LinkFlow.getDiagnostics());
```

- **Organic installs:** servers from 2.2 return an install id and token for
  unmatched installs too. The native SDKs store them, so organic users' events,
  revenue and `setCustomerUserId` reach the server. With older servers nothing
  changes.
- **Why didn't my deep link fire?** In `getDiagnostics()`, check
  `deepLinksHeld` / `jsDeepLinksHeld` (call `releaseDeepLinks()`),
  `consentState` (`pending` buffers the launch until `setConsent`),
  `lastResolveResult` (`attributed`, `organic`, `rejected`, `network_error`,
  `invalid_response`) and `nativeLinkForwarding`.
- On a native build older than 2.2.0, `holdDeepLinks()` still holds
  `useLinkFlowDeepLink` and the Expo Router adapter. Raw
  `addDeepLinkListener` / `addAttributionListener` events are not held, and a
  warning is logged. Rebuild the app to fix it.

## Expo

The package includes a config plugin. It does not work in Expo Go, because
the SDK has native code. Use a development build.

### Managed workflow (and `expo prebuild`)

```bash
npx expo install @linkflow/react-native-sdk
```

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      ["@linkflow/react-native-sdk", {
        "domains": ["go.example.com"],
        "userTrackingPermission": "Used to measure which ads brought you here.",
        "attributionReportEndpoint": "https://go.example.com"
      }]
    ]
  }
}
```

| Option | Default | Effect |
|---|---|---|
| `domains` | `[]` | Your LinkFlow link domains. iOS: `applinks:<domain>` in Associated Domains. Android: one `autoVerify` App Links intent filter for all of them. |
| `scheme` | app.json `scheme` | Custom URL scheme(s): iOS `CFBundleURLTypes` and an Android intent filter, each added only if missing. |
| `forwardNativeLinks` | `true` | Forwards links natively: iOS `open url` / `continue userActivity` in the AppDelegate (Swift for SDK 53+, Objective-C for SDK 52), Android `onNewIntent` in MainActivity. Sets a flag so JS does not forward the same link again. |
| `userTrackingPermission` | — | `NSUserTrackingUsageDescription`. Set it only if your app shows the ATT prompt; the SDK never shows it. |
| `attributionReportEndpoint` | — | `NSAdvertisingAttributionReportEndpoint` and `AttributionCopyEndpoint` (https URL of your verified LinkFlow domain), for developer copies of SKAdNetwork / AdAttributionKit postbacks. |
| `androidAutoVerify` | `true` | `android:autoVerify` on the App Links filter. |

Running `npx expo prebuild` again changes nothing further: every edit is
idempotent. If the plugin does not recognise your AppDelegate or MainActivity
(heavily customised native code), prebuild fails with a message instead of
guessing. Set `forwardNativeLinks: false` and add the calls as described in
[Bare React Native](#bare-react-native).

App Links and universal links also need the domain-side files
(`apple-app-site-association`, `assetlinks.json`). LinkFlow serves them for
verified custom domains.

### Expo Router

Map LinkFlow links to routes in `app/+native-intent.tsx`:

```ts
import { createLinkFlowRedirectSystemPath } from '@linkflow/react-native-sdk';

export const redirectSystemPath = createLinkFlowRedirectSystemPath({
  domains: ['go.example.com'],
  schemes: ['myapp'],
  // Optional:
  // mapDeepLink: (link) => (link.params.sku ? `/product/${link.params.sku}` : undefined),
  // resolveShortLinks: true,   // GET /api/links/resolve/{code} (records a click, like a browser redirect)
  // fallbackPath: '/',
});
```

Each incoming URL is handled as follows:

- **Not a LinkFlow link and not one of your schemes:** returned unchanged.
- **Deep links held:** returns `fallbackPath`. The link is delivered to
  `useLinkFlowDeepLink` on `releaseDeepLinks()`.
- **Otherwise:** the destination is taken from `deep_link_value` /
  `deepLinkValue` / `path`, or from your `mapDeepLink`. Tracking parameters
  (`utm_*`, `click_token`, `lf_*`) are dropped and other query parameters
  are kept. A short link without a destination returns `fallbackPath`,
  unless `resolveShortLinks` is on.

Deferred deep links never pass through `+native-intent` because there is no
URL to open, so handle them with the hook in your root layout:

```tsx
import { useRouter } from 'expo-router';
import LinkFlow, { useLinkFlowDeepLink } from '@linkflow/react-native-sdk';

export default function RootLayout() {
  const router = useRouter();
  useLinkFlowDeepLink((link) => {
    if (link.path) router.push(link.path); // link.type: 'deferred' | 'direct'
  });
  // e.g. after onboarding: LinkFlow.releaseDeepLinks()
  return <Stack />;
}
```

The hook is held while deep links are held. It delivers a link that arrived
before it mounted, and it skips URLs that `redirectSystemPath` already
routed, so nothing navigates twice.

## Bare React Native

`npm install @linkflow/react-native-sdk`, then `cd ios && pod install`.
Without any native changes, JS forwards `Linking` URLs to the SDK and
everything works. Optionally, forward links natively, which is what the Expo
plugin does:

**iOS:** add Associated Domains `applinks:go.example.com` and your URL scheme.
Then, in `AppDelegate.swift`:

```swift
import LinkFlowSDK

func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
  LinkFlowLinkForwarder.open(url)
  return RCTLinkingManager.application(app, open: url, options: options)
}

func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                 restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
  LinkFlowLinkForwarder.continueUserActivity(userActivity)
  return RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
}
```

In Objective-C:
`[(id)NSClassFromString(@"LinkFlowLinkForwarder") performSelector:@selector(openURL:) withObject:url];`.
Then set `LinkFlowNativeLinkForwarding` (Boolean, YES) in Info.plist.

**Android:** add an `autoVerify` intent filter for `https://go.example.com` and
your scheme to MainActivity. Then add:

```kotlin
override fun onNewIntent(intent: Intent) {
  super.onNewIntent(intent)
  com.linkflow.sdk.rn.LinkFlowLinkForwarder.onNewIntent(intent)
}
```

and in `<application>`:
`<meta-data android:name="com.linkflow.sdk.NATIVE_LINK_FORWARDING" android:value="true"/>`.

React Navigation users can call `useLinkFlowDeepLink` (it does not depend on
Expo Router) and `navigation.navigate(...)` from the callback.

## What's new in 2.1

```ts
await LinkFlow.initialize({ appKey: 'lfa_...', manageConversionValues: true }); // iOS: managed SKAN/AAK values
await LinkFlow.setCustomerUserId('user-123');                                    // null on logout
await LinkFlow.setConsent({ attribution: true, gdprApplies: true, tcfString, adUserData: true, adPersonalization: false });
```

All additions are optional; 2.0 code keeps working, and the JS layer falls back
to the 2.0 native methods if the app's native build is older.

## API Reference

### `LinkFlow.initialize(config)`

Initialize the SDK.

```typescript
await LinkFlow.initialize({
  apiBaseURL: 'https://thelinkflow.app',
  enableLogging: true
});
```

### `LinkFlow.addAttributionListener(callback)` → `EmitterSubscription`

Subscribe to attribution-resolved events. Call `.remove()` on the returned
subscription when the listener is no longer needed.

```typescript
const sub = LinkFlow.addAttributionListener((result) => {
  console.log(result);
});
// cleanup
sub.remove();
```

### `LinkFlow.addDeepLinkListener(callback)` → `EmitterSubscription`

Subscribe to deep link events received while the app is running.

### `LinkFlow.addErrorListener(callback)` → `EmitterSubscription`

Subscribe to non-fatal errors emitted by the native SDK.

### `LinkFlow.setAttributionCallback(callback)` *(deprecated)*

> **Deprecated since 1.1.0.** Use `addAttributionListener` instead. Kept for
> backward compatibility with v1.0.x consumers; will be removed in 2.0.0.

```typescript
LinkFlow.setAttributionCallback((result) => {
  console.log(result);
});
```

### `LinkFlow.getLastAttributionResult()` → `AttributionResult | null`

Synchronously returns the most recent attribution result cached in JS, or
`null` if none has been resolved yet.

### `LinkFlow.handleAppLaunch()`

Handle app launch and resolve attribution.

```typescript
await LinkFlow.handleAppLaunch();
```

### `LinkFlow.trackEvent(eventName, params, revenue)`

Track in-app events.

```typescript
await LinkFlow.trackEvent('purchase', { order_id: '123' }, 99.99);
```

### `LinkFlow.getAttributionResult()`

Get attribution result if available.

```typescript
const result = await LinkFlow.getAttributionResult();
```

### `LinkFlow.holdDeepLinks()` / `LinkFlow.releaseDeepLinks()` / `LinkFlow.isHoldingDeepLinks()` *(2.2.0+)*

Queue deferred and direct deep links (latest per kind) until release. Not held by default.

### `LinkFlow.getDiagnostics()` → `Promise<LinkFlowDiagnostics>` *(2.2.0+)*

PII-free support snapshot.

### `useLinkFlowDeepLink(onDeepLink?)` → `LinkFlowRoutedDeepLink | null` *(2.2.0+)*

React hook delivering `{ type, url?, deepLinkValue?, params, attribution?, path }`.

### `createLinkFlowRedirectSystemPath(options)` *(2.2.0+)*

Expo Router `redirectSystemPath` implementation. See [Expo Router](#expo-router).

## TypeScript Support

Full TypeScript support included:

```typescript
import LinkFlow, { AttributionResult } from '@linkflow/react-native-sdk';

const handleAttribution = (result: AttributionResult) => {
  if (result.attributed) {
    // TypeScript knows all properties
    console.log(result.deepLinkValue);
    console.log(result.campaignData);
  }
};
```

## Requirements

- React Native 0.60+
- iOS 13.0+
- Android API 21+

## License

MIT License
