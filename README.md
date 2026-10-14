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

Add to `Info.plist`:
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
