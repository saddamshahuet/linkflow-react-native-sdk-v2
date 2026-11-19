/**
 * @linkflow/react-native-sdk
 * Mobile attribution and deferred deep linking for React Native.
 */
import {
  Linking,
  NativeEventEmitter,
  NativeModules,
  Platform,
} from 'react-native';
import type { EmitterSubscription } from 'react-native';

import {
  carriesDeepLink,
  deepLinkBus,
  deferredLink,
  directLink,
} from './deepLinkBus';

/** Version of this package; kept in step with the native SDKs it vendors. */
export const SDK_VERSION = '2.2.0';

const LINKING_ERROR =
  `The package '@linkflow/react-native-sdk' doesn't seem to be linked. Make sure: \n\n` +
  Platform.select({ ios: "- Run 'pod install'\n", default: '' }) +
  '- Rebuild the app after installing the package\n' +
  '- You are not using Expo Go (use a custom dev client instead)\n';

const NativeLinkFlow = NativeModules.LinkFlowSDK
  ? NativeModules.LinkFlowSDK
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      }
    );

const eventEmitter = new NativeEventEmitter(NativeLinkFlow);

// ---------- Types ----------

export interface AttributionResult {
  attributed: boolean;
  deepLinkValue?: string;
  deepLinkParams?: Record<string, any>;
  campaignData?: Record<string, any>;
  /**
   * How the install was matched: `install_referrer` and `click_token` are
   * deterministic, `device_id` near-deterministic, `fingerprint` probabilistic.
   */
  attributionMethod?: AttributionMethod;
  /**
   * Match confidence, 0–1. Deterministic matches report 1; fingerprint matches
   * report a score computed from how many device signals corroborated the match.
   * Absent when the server did not report one.
   */
  confidence?: number;
  /** True when this device had already installed the app before. */
  isReinstall?: boolean;
  /**
   * 2.2.0+: how the server matched the install, when it reports a `match`
   * object. Absent with older servers or native builds.
   */
  match?: AttributionMatch;
}

/** 2.2.0+: the server's match report for an install. */
export interface AttributionMatch {
  method: MatchMethod;
  /** 0–1, when reported. */
  confidence?: number;
}

export type MatchMethod =
  | 'install_referrer'
  | 'click_token'
  | 'advertising_id'
  | 'probabilistic'
  | 'organic'
  // Forward compatible: a newer server may report a method this version does not know.
  | (string & {});

/**
 * 2.2.0+: support snapshot from `LinkFlow.getDiagnostics()`. Contains no
 * identifiers or personal data: only versions, the API host, flags, counts
 * and categories.
 */
export interface LinkFlowDiagnostics {
  /** Version of this JS package. */
  jsSdkVersion: string;
  /** Version of the native SDK (absent on a native build older than 2.2.0). */
  sdkVersion?: string;
  platform?: 'ios' | 'android';
  apiHost?: string;
  appKeyConfigured?: boolean;
  consentState?: 'not_required' | 'pending' | 'granted' | 'denied';
  advertisingIdConsent?: boolean;
  launchPendingConsent?: boolean;
  hasInstallId?: boolean;
  hasInstallToken?: boolean;
  customerUserIdSet?: boolean;
  attributionComplete?: boolean;
  /** ISO-8601 time of the last attribution request's outcome. */
  lastResolveAt?: string;
  lastResolveResult?:
    | 'attributed'
    | 'organic'
    | 'rejected'
    | 'network_error'
    | 'invalid_response';
  lastMatchMethod?: string;
  queuedEventCount?: number;
  /** Native hold state. */
  deepLinksHeld?: boolean;
  heldDeepLinkCount?: number;
  attributionCallbackSet?: boolean;
  /** JS hold state (the hook / router adapter gate). */
  jsDeepLinksHeld: boolean;
  jsHeldDeepLinkCount: number;
  /** True when the AppDelegate / MainActivity forwards links natively (Expo plugin). */
  nativeLinkForwarding: boolean;
  initialized: boolean;
  /** False when the native build predates 2.2.0 and only JS fields are present. */
  nativeDiagnosticsAvailable: boolean;
}

export type AttributionMethod =
  | 'install_referrer'
  | 'click_token'
  | 'device_id'
  | 'fingerprint';

export interface DeepLinkEvent {
  url: string;
}

export interface LinkFlowError {
  message: string;
}

export interface LinkFlowConfig {
  apiBaseURL?: string;
  enableLogging?: boolean;
  /**
   * Public app key from the dashboard (App Keys). Embeddable in the app bundle.
   * Optional today; required once the server enforces app keys.
   */
  appKey?: string;
  /**
   * When true the SDK collects and sends nothing until `setConsent` is called.
   * A launch requested while consent is pending is buffered and replayed on
   * grant, so no attribution is lost to the consent prompt.
   */
  requireConsent?: boolean;
  /** Whether the SDK may read the advertising identifier (GAID / IDFA). */
  collectAdvertisingId?: boolean;
  /**
   * iOS only (2.1.0+): let the SDK set SKAdNetwork / AdAttributionKit conversion
   * values from the schema approved in the LinkFlow dashboard. Off by default so
   * an app that manages its own conversion values is never overridden. Requires
   * `appKey`. Ignored on Android.
   */
  manageConversionValues?: boolean;
}

export interface LinkFlowConsent {
  /** Permits attribution resolution and event reporting. */
  attribution: boolean;
  /** Permits reading the advertising identifier. Defaults to `attribution`. */
  advertisingId?: boolean;
  /** 2.1.0+: true when the user is subject to GDPR / the DMA. */
  gdprApplies?: boolean;
  /** 2.1.0+: IAB TCF v2 consent string from your CMP. */
  tcfString?: string;
  /** 2.1.0+: Google consent mode v2 `ad_user_data`. */
  adUserData?: boolean;
  /** 2.1.0+: Google consent mode v2 `ad_personalization`. */
  adPersonalization?: boolean;
}

export type AttributionCallback = (result: AttributionResult) => void;
export type DeepLinkCallback = (event: DeepLinkEvent) => void;
export type ErrorCallback = (error: LinkFlowError) => void;

// ---------- Constants ----------

const EVENT_ATTRIBUTION = 'LinkFlowAttribution';
const EVENT_DEEPLINK = 'LinkFlowDeepLink';
const EVENT_ERROR = 'LinkFlowError';

// ---------- SDK ----------

class LinkFlow {
  private static initialized = false;
  private static lastResult: AttributionResult | null = null;
  private static linkingSubscription: EmitterSubscription | null = null;
  private static internalAttributionSub: EmitterSubscription | null = null;
  private static legacyCallbackSub: EmitterSubscription | null = null;
  private static busAttributionSub: EmitterSubscription | null = null;
  private static busDeepLinkSub: EmitterSubscription | null = null;
  private static nativeHoldRequested = false;
  private static warnedNoNativeHold = false;

  /**
   * Initialize the LinkFlow SDK. Must be called once at app launch before
   * any other method.
   */
  static async initialize(config: LinkFlowConfig = {}): Promise<void> {
    if (this.initialized) {
      console.warn('[LinkFlow] SDK already initialized');
      return;
    }
    const {
      apiBaseURL = 'https://thelinkflow.app',
      enableLogging = false,
      appKey,
      requireConsent = false,
      collectAdvertisingId = true,
      manageConversionValues = false,
    } = config;

    await NativeLinkFlow.initialize(apiBaseURL, enableLogging, {
      appKey,
      requireConsent,
      collectAdvertisingId,
      manageConversionValues,
    });
    this.initialized = true;

    // Cache the most recent attribution result so consumers that subscribe
    // late can still fetch it via getLastAttributionResult().
    this.internalAttributionSub = eventEmitter.addListener(
      EVENT_ATTRIBUTION,
      (result: AttributionResult) => {
        this.lastResult = result;
      }
    );

    // Feed the JS deep-link gate used by useLinkFlowDeepLink / Expo Router.
    this.busAttributionSub = eventEmitter.addListener(
      EVENT_ATTRIBUTION,
      (result: AttributionResult) => {
        if (carriesDeepLink(result)) deepLinkBus.publish(deferredLink(result));
      }
    );
    this.busDeepLinkSub = eventEmitter.addListener(
      EVENT_DEEPLINK,
      (event: DeepLinkEvent) => {
        if (event?.url) deepLinkBus.publish(directLink(event.url));
      }
    );

    // holdDeepLinks() may have been called before initialize().
    if (this.nativeHoldRequested) {
      await this.callNativeHold();
    }

    this.setupDeepLinkListener();
  }

  /**
   * 2.2.0+: hold deep links until `releaseDeepLinks()`, e.g. while a splash
   * screen, onboarding or login is showing.
   *
   * While held, the deferred deep link and direct deep links are queued
   * (latest of each kind) by the native SDK and by the JS gate behind
   * `useLinkFlowDeepLink` and the Expo Router adapter. Attribution, events and
   * `getAttributionResult()` are unaffected. May be called before
   * `initialize()` so that even the first deferred link is held. Not held by
   * default.
   */
  static async holdDeepLinks(): Promise<void> {
    deepLinkBus.hold();
    this.nativeHoldRequested = true;
    if (this.initialized) await this.callNativeHold();
  }

  /** 2.2.0+: stop holding and deliver what was queued, in arrival order. */
  static async releaseDeepLinks(): Promise<void> {
    this.nativeHoldRequested = false;
    // JS first, so links the native SDK releases next pass straight through.
    deepLinkBus.release();
    if (this.initialized && typeof NativeLinkFlow.releaseDeepLinks === 'function') {
      await NativeLinkFlow.releaseDeepLinks();
    }
  }

  /** 2.2.0+: true between `holdDeepLinks()` and `releaseDeepLinks()`. */
  static isHoldingDeepLinks(): boolean {
    return deepLinkBus.isHeld();
  }

  /**
   * 2.2.0+: a support snapshot ("why didn't my deep link fire?"): SDK
   * versions, API host, consent state, whether an install id exists, the last
   * attribution outcome, queued events and hold state. Contains no
   * identifiers or personal data.
   */
  static async getDiagnostics(): Promise<LinkFlowDiagnostics> {
    const js = {
      jsSdkVersion: SDK_VERSION,
      jsDeepLinksHeld: deepLinkBus.isHeld(),
      jsHeldDeepLinkCount: deepLinkBus.heldCount(),
      nativeLinkForwarding: this.nativeLinkForwarding(),
      initialized: this.initialized,
    };
    if (this.initialized && typeof NativeLinkFlow.getDiagnostics === 'function') {
      const native = await NativeLinkFlow.getDiagnostics();
      return { ...native, ...js, nativeDiagnosticsAvailable: true };
    }
    return { ...js, nativeDiagnosticsAvailable: false };
  }

  /**
   * Subscribe to attribution-resolved events. Returns a subscription you
   * MUST call `.remove()` on when the listener is no longer needed (typically
   * in a useEffect cleanup).
   */
  static addAttributionListener(
    callback: AttributionCallback
  ): EmitterSubscription {
    return eventEmitter.addListener(EVENT_ATTRIBUTION, callback);
  }

  /** Subscribe to deep link events received while the app is running. */
  static addDeepLinkListener(
    callback: DeepLinkCallback
  ): EmitterSubscription {
    return eventEmitter.addListener(EVENT_DEEPLINK, callback);
  }

  /** Subscribe to non-fatal errors emitted by the native SDK. */
  static addErrorListener(callback: ErrorCallback): EmitterSubscription {
    return eventEmitter.addListener(EVENT_ERROR, callback);
  }

  /**
   * @deprecated Use `addAttributionListener` instead. Single-callback
   * accessor kept for backward compatibility with v1.0.x consumers.
   */
  static setAttributionCallback(callback: AttributionCallback): void {
    this.legacyCallbackSub?.remove();
    this.legacyCallbackSub = eventEmitter.addListener(
      EVENT_ATTRIBUTION,
      callback
    );
  }

  /**
   * Handle app launch. Call this once after `initialize()` (typically in a
   * top-level useEffect). It triggers attribution resolution on first launch
   * and replays the cached result on subsequent launches.
   */
  static async handleAppLaunch(): Promise<void> {
    this.assertInitialized();
    const initialUrl = await Linking.getInitialURL();
    await NativeLinkFlow.handleAppLaunch(initialUrl);
  }

  /** Manually feed a deep link into the SDK (rarely needed). */
  static async handleDeepLink(url: string): Promise<void> {
    this.assertInitialized();
    await NativeLinkFlow.handleDeepLink(url);
  }

  /**
   * Track an in-app event.
   *
   * @param eventName e.g. `'purchase'`, `'add_to_cart'`
   * @param params custom event properties
   * @param revenue optional revenue amount in the project's currency
   */
  static async trackEvent(
    eventName: string,
    params?: Record<string, any>,
    revenue?: number
  ): Promise<void> {
    this.assertInitialized();
    await NativeLinkFlow.trackEvent(eventName, params || {}, revenue ?? null);
  }

  /**
   * Returns the most recent attribution result, or `null` if none has been
   * resolved yet. Reads from native cache + JS in-memory cache.
   */
  static async getAttributionResult(): Promise<AttributionResult | null> {
    this.assertInitialized();
    const native = await NativeLinkFlow.getAttributionResult();
    return native ?? this.lastResult;
  }

  /** Returns the cached result synchronously without making a native call. */
  static getLastAttributionResult(): AttributionResult | null {
    return this.lastResult;
  }

  /**
   * Records the user's consent decision.
   *
   * Only needed when the SDK was initialized with `requireConsent: true`.
   * Granting consent replays any launch buffered while waiting.
   */
  static async setConsent(consent: LinkFlowConsent): Promise<void> {
    this.assertInitialized();
    const advertisingId = consent.advertisingId ?? consent.attribution;
    const signals = consentSignals(consent);
    // The granular-signal method is 2.1.0+ native code; fall back to the
    // original method if the native side is older (e.g. a stale native build).
    if (signals && typeof NativeLinkFlow.setConsentWithSignals === 'function') {
      await NativeLinkFlow.setConsentWithSignals(
        consent.attribution,
        advertisingId,
        signals
      );
      return;
    }
    await NativeLinkFlow.setConsent(consent.attribution, advertisingId);
  }

  /**
   * Associates your own user id with this install (2.1.0+), e.g. after login.
   * Pass `null` on logout to stop attaching it to new events.
   */
  static async setCustomerUserId(customerUserId: string | null): Promise<void> {
    this.assertInitialized();
    if (typeof NativeLinkFlow.setCustomerUserId !== 'function') {
      console.warn('[LinkFlow] setCustomerUserId requires native SDK 2.1.0+; rebuild the app.');
      return;
    }
    await NativeLinkFlow.setCustomerUserId(customerUserId);
  }

  /**
   * Number of events queued for delivery.
   *
   * Events are persisted and retried, so a non-zero count simply means delivery
   * has not completed yet — typically because the device is offline or
   * attribution has not yet produced an install id.
   */
  static async pendingEventCount(): Promise<number> {
    this.assertInitialized();
    return NativeLinkFlow.pendingEventCount();
  }

  /** Tear down all internal listeners. */
  static destroy(): void {
    this.linkingSubscription?.remove();
    this.linkingSubscription = null;
    this.internalAttributionSub?.remove();
    this.internalAttributionSub = null;
    this.legacyCallbackSub?.remove();
    this.legacyCallbackSub = null;
    this.busAttributionSub?.remove();
    this.busAttributionSub = null;
    this.busDeepLinkSub?.remove();
    this.busDeepLinkSub = null;
    this.nativeHoldRequested = false;
    deepLinkBus.reset();
    this.initialized = false;
    this.lastResult = null;
  }

  private static async callNativeHold(): Promise<void> {
    if (typeof NativeLinkFlow.holdDeepLinks === 'function') {
      await NativeLinkFlow.holdDeepLinks();
    } else if (!this.warnedNoNativeHold) {
      this.warnedNoNativeHold = true;
      console.warn(
        '[LinkFlow] holdDeepLinks requires native SDK 2.2.0+ for addDeepLinkListener/addAttributionListener; ' +
          'only useLinkFlowDeepLink and the Expo Router adapter are held. Rebuild the app.'
      );
    }
  }

  /** True when the app forwards links natively (Expo config plugin), so JS must not forward them again. */
  private static nativeLinkForwarding(): boolean {
    try {
      return NativeLinkFlow.nativeLinkForwarding === true;
    } catch {
      return false;
    }
  }

  private static setupDeepLinkListener(): void {
    if (this.linkingSubscription) return;
    // With native forwarding (AppDelegate / MainActivity) the native SDK already
    // receives every link; forwarding it from JS as well would deliver it twice.
    if (this.nativeLinkForwarding()) return;
    this.linkingSubscription = Linking.addEventListener('url', ({ url }) => {
      if (url) {
        NativeLinkFlow.handleDeepLink(url).catch((err: unknown) =>
          console.error('[LinkFlow] handleDeepLink failed:', err)
        );
      }
    });
  }

  private static assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        '[LinkFlow] SDK not initialized. Call LinkFlow.initialize() first.'
      );
    }
  }
}

/** The granular consent fields that were actually supplied, or null when none were. */
export function consentSignals(
  consent: LinkFlowConsent
): Record<string, string | boolean> | null {
  const out: Record<string, string | boolean> = {};
  if (consent.gdprApplies !== undefined) out.gdprApplies = consent.gdprApplies;
  if (consent.tcfString !== undefined) out.tcfString = consent.tcfString;
  if (consent.adUserData !== undefined) out.adUserData = consent.adUserData;
  if (consent.adPersonalization !== undefined) out.adPersonalization = consent.adPersonalization;
  return Object.keys(out).length > 0 ? out : null;
}

export default LinkFlow;
export { LinkFlow };

export type { LinkFlowDeepLink, LinkFlowDeepLinkType } from './deepLinkBus';
export {
  configureLinkFlowRouter,
  createLinkFlowRedirectSystemPath,
  deepLinkToPath,
  resolveLinkFlowPath,
  shortLinkCode,
} from './expoRouter';
export type { LinkFlowRouterOptions, RedirectSystemPathEvent } from './expoRouter';
export { useLinkFlowDeepLink } from './useLinkFlowDeepLink';
export type { LinkFlowRoutedDeepLink } from './useLinkFlowDeepLink';
