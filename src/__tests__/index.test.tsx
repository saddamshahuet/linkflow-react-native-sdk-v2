/**
 * Tests for the JS surface of the React Native SDK.
 *
 * The native module is mocked, so what is under test is the bridge contract:
 * that options reach native in the shape the Android and iOS modules expect,
 * that consent maps correctly, and that subscriptions are cleaned up. A
 * mismatch here is silent at runtime — exactly the class of bug that left the
 * server ignoring fields the SDKs were sending.
 */

// The factory must be self-contained: `jest.mock` is hoisted above the imports,
// so it cannot close over variables declared in this file.
jest.mock('react-native', () => {
  const subscription = { remove: jest.fn() };

  return {
    __subscription: subscription,
    NativeModules: {
      LinkFlowSDK: {
        initialize: jest.fn().mockResolvedValue(undefined),
        handleAppLaunch: jest.fn().mockResolvedValue(undefined),
        handleDeepLink: jest.fn().mockResolvedValue(undefined),
        trackEvent: jest.fn().mockResolvedValue(undefined),
        getAttributionResult: jest.fn().mockResolvedValue(null),
        setConsent: jest.fn().mockResolvedValue(undefined),
        setConsentWithSignals: jest.fn().mockResolvedValue(undefined),
        setCustomerUserId: jest.fn().mockResolvedValue(undefined),
        pendingEventCount: jest.fn().mockResolvedValue(0),
        addListener: jest.fn(),
        removeListeners: jest.fn(),
      },
    },
    NativeEventEmitter: jest.fn().mockImplementation(() => ({
      addListener: jest.fn(() => subscription),
    })),
    Linking: {
      getInitialURL: jest.fn().mockResolvedValue(null),
      addEventListener: jest.fn(() => subscription),
    },
    Platform: { select: jest.fn(() => '') },
  };
});

import { NativeModules } from 'react-native';
import LinkFlow from '../index';

const mockNative = NativeModules.LinkFlowSDK as any;
const mockSubscription = (jest.requireMock('react-native') as any)
  .__subscription;

describe('LinkFlow', () => {
  beforeEach(() => {
    LinkFlow.destroy();
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('passes the options object native expects', async () => {
      await LinkFlow.initialize({
        apiBaseURL: 'https://test.thelinkflow.app',
        enableLogging: true,
        appKey: 'lfa_test',
        requireConsent: true,
        collectAdvertisingId: false,
      });

      expect(mockNative.initialize).toHaveBeenCalledWith(
        'https://test.thelinkflow.app',
        true,
        {
          appKey: 'lfa_test',
          requireConsent: true,
          collectAdvertisingId: false,
          manageConversionValues: false,
        }
      );
    });

    it('applies defaults matching the native SDKs', async () => {
      await LinkFlow.initialize();

      expect(mockNative.initialize).toHaveBeenCalledWith(
        'https://thelinkflow.app',
        false,
        {
          appKey: undefined,
          requireConsent: false,
          collectAdvertisingId: true,
          manageConversionValues: false,
        }
      );
    });

    it('is idempotent', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await LinkFlow.initialize();
      await LinkFlow.initialize();

      expect(mockNative.initialize).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('setConsent', () => {
    beforeEach(async () => {
      await LinkFlow.initialize();
    });

    it('defaults advertising consent to the attribution decision', async () => {
      await LinkFlow.setConsent({ attribution: true });
      expect(mockNative.setConsent).toHaveBeenCalledWith(true, true);
    });

    it('allows advertising consent to be withheld independently', async () => {
      await LinkFlow.setConsent({ attribution: true, advertisingId: false });
      expect(mockNative.setConsent).toHaveBeenCalledWith(true, false);
    });

    it('propagates a full refusal', async () => {
      await LinkFlow.setConsent({ attribution: false });
      expect(mockNative.setConsent).toHaveBeenCalledWith(false, false);
    });

    it('keeps the 2.0 native call when no granular signals are given', async () => {
      await LinkFlow.setConsent({ attribution: true });
      expect(mockNative.setConsentWithSignals).not.toHaveBeenCalled();
    });

    it('forwards granular consent signals (2.1.0+)', async () => {
      await LinkFlow.setConsent({
        attribution: true,
        gdprApplies: true,
        tcfString: 'CP-x',
        adPersonalization: false,
      });
      expect(mockNative.setConsentWithSignals).toHaveBeenCalledWith(true, true, {
        gdprApplies: true,
        tcfString: 'CP-x',
        adPersonalization: false,
      });
      expect(mockNative.setConsent).not.toHaveBeenCalled();
    });

    it('falls back to the 2.0 native method on an older native build', async () => {
      const saved = mockNative.setConsentWithSignals;
      delete mockNative.setConsentWithSignals;
      await LinkFlow.setConsent({ attribution: true, adUserData: true });
      expect(mockNative.setConsent).toHaveBeenCalledWith(true, true);
      mockNative.setConsentWithSignals = saved;
    });
  });

  describe('setCustomerUserId', () => {
    it('forwards the id and null on logout', async () => {
      await LinkFlow.initialize();
      await LinkFlow.setCustomerUserId('user-1');
      await LinkFlow.setCustomerUserId(null);
      expect(mockNative.setCustomerUserId).toHaveBeenNthCalledWith(1, 'user-1');
      expect(mockNative.setCustomerUserId).toHaveBeenNthCalledWith(2, null);
    });
  });

  describe('manageConversionValues', () => {
    it('is forwarded to native when enabled', async () => {
      await LinkFlow.initialize({ appKey: 'lfa_x', manageConversionValues: true });
      expect(mockNative.initialize).toHaveBeenCalledWith(
        'https://thelinkflow.app',
        false,
        expect.objectContaining({ manageConversionValues: true })
      );
    });
  });

  describe('guards', () => {
    it('throws when used before initialization', async () => {
      await expect(LinkFlow.trackEvent('purchase')).rejects.toThrow(
        /not initialized/i
      );
      await expect(LinkFlow.setConsent({ attribution: true })).rejects.toThrow(
        /not initialized/i
      );
      await expect(LinkFlow.pendingEventCount()).rejects.toThrow(
        /not initialized/i
      );
    });
  });

  describe('trackEvent', () => {
    beforeEach(async () => {
      await LinkFlow.initialize();
    });

    it('normalizes optional arguments for the native bridge', async () => {
      await LinkFlow.trackEvent('purchase');
      expect(mockNative.trackEvent).toHaveBeenCalledWith('purchase', {}, null);
    });

    it('forwards params and revenue', async () => {
      await LinkFlow.trackEvent('purchase', { sku: 'abc' }, 9.99);
      expect(mockNative.trackEvent).toHaveBeenCalledWith(
        'purchase',
        { sku: 'abc' },
        9.99
      );
    });
  });

  describe('pendingEventCount', () => {
    it('returns the native queue depth', async () => {
      await LinkFlow.initialize();
      mockNative.pendingEventCount.mockResolvedValueOnce(3);

      await expect(LinkFlow.pendingEventCount()).resolves.toBe(3);
    });
  });

  describe('destroy', () => {
    it('removes subscriptions so a reload does not leak listeners', async () => {
      await LinkFlow.initialize();
      LinkFlow.destroy();

      expect(mockSubscription.remove).toHaveBeenCalled();

      // And the SDK is usable again afterwards.
      await LinkFlow.initialize();
      expect(mockNative.initialize).toHaveBeenCalledTimes(2);
    });
  });
});
