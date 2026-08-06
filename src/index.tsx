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
}

export interface LinkFlowConsent {
  /** Permits attribution resolution and event reporting. */
  attribution: boolean;
  /** Permits reading the advertising identifier. Defaults to `attribution`. */
  advertisingId?: boolean;
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
    } = config;

    await NativeLinkFlow.initialize(apiBaseURL, enableLogging, {
      appKey,
      requireConsent,
      collectAdvertisingId,
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

    this.setupDeepLinkListener();
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
    await NativeLinkFlow.setConsent(
      consent.attribution,
      consent.advertisingId ?? consent.attribution
    );
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
    this.initialized = false;
    this.lastResult = null;
  }

  private static setupDeepLinkListener(): void {
    if (this.linkingSubscription) return;
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

export default LinkFlow;
export { LinkFlow };
