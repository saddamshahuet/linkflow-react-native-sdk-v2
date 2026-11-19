/**
 * 2.2.0: deep link hold/release, diagnostics, the JS deep-link gate, the Expo
 * Router adapter and useLinkFlowDeepLink.
 */
jest.mock('react-native', () => {
  const listeners: Record<string, Array<(payload: any) => void>> = {};
  const emitter = {
    addListener: jest.fn((name: string, cb: (payload: any) => void) => {
      (listeners[name] = listeners[name] || []).push(cb);
      return {
        remove: jest.fn(() => {
          listeners[name] = (listeners[name] || []).filter((x) => x !== cb);
        }),
      };
    }),
  };
  return {
    __emit: (name: string, payload: any) =>
      (listeners[name] || []).slice().forEach((cb) => cb(payload)),
    NativeModules: {
      LinkFlowSDK: {
        initialize: jest.fn().mockResolvedValue(undefined),
        handleAppLaunch: jest.fn().mockResolvedValue(undefined),
        handleDeepLink: jest.fn().mockResolvedValue(undefined),
        getAttributionResult: jest.fn().mockResolvedValue(null),
        holdDeepLinks: jest.fn().mockResolvedValue(undefined),
        releaseDeepLinks: jest.fn().mockResolvedValue(undefined),
        getDiagnostics: jest.fn().mockResolvedValue({
          sdkVersion: '2.2.0',
          platform: 'android',
          apiHost: 'thelinkflow.app',
          hasInstallId: true,
          lastResolveResult: 'organic',
          queuedEventCount: 0,
          deepLinksHeld: false,
        }),
        nativeLinkForwarding: false,
        addListener: jest.fn(),
        removeListeners: jest.fn(),
      },
    },
    NativeEventEmitter: jest.fn().mockImplementation(() => emitter),
    Linking: {
      getInitialURL: jest.fn().mockResolvedValue(null),
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    Platform: { select: jest.fn(() => '') },
  };
});

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking, NativeModules } from 'react-native';

import LinkFlow, {
  SDK_VERSION,
  configureLinkFlowRouter,
  createLinkFlowRedirectSystemPath,
  deepLinkToPath,
  shortLinkCode,
  useLinkFlowDeepLink,
} from '../index';
import type { LinkFlowRoutedDeepLink } from '../index';
import { DeepLinkBus, deepLinkBus, directLink, queryParams } from '../deepLinkBus';
import { resolveLinkFlowPath, valueToPath } from '../expoRouter';

const mockNative = NativeModules.LinkFlowSDK as any;
const emit = (jest.requireMock('react-native') as any).__emit as (
  name: string,
  payload: any
) => void;

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  LinkFlow.destroy();
  configureLinkFlowRouter({});
  jest.clearAllMocks();
  mockNative.nativeLinkForwarding = false;
});

describe('version', () => {
  it('matches package.json', () => {
    expect(SDK_VERSION).toBe(require('../../package.json').version);
    expect(SDK_VERSION).toBe('2.2.0');
  });
});

describe('holdDeepLinks / releaseDeepLinks', () => {
  it('is not held by default', async () => {
    await LinkFlow.initialize();
    expect(LinkFlow.isHoldingDeepLinks()).toBe(false);
    expect(mockNative.holdDeepLinks).not.toHaveBeenCalled();
  });

  it('forwards to native once initialized', async () => {
    await LinkFlow.initialize();
    await LinkFlow.holdDeepLinks();
    expect(LinkFlow.isHoldingDeepLinks()).toBe(true);
    expect(mockNative.holdDeepLinks).toHaveBeenCalledTimes(1);

    await LinkFlow.releaseDeepLinks();
    expect(LinkFlow.isHoldingDeepLinks()).toBe(false);
    expect(mockNative.releaseDeepLinks).toHaveBeenCalledTimes(1);
  });

  it('can be called before initialize so the first deferred link is held', async () => {
    await LinkFlow.holdDeepLinks();
    expect(mockNative.holdDeepLinks).not.toHaveBeenCalled();
    await LinkFlow.initialize();
    expect(mockNative.holdDeepLinks).toHaveBeenCalledTimes(1);
  });

  it('tolerates a native build older than 2.2.0', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const hold = mockNative.holdDeepLinks;
    const release = mockNative.releaseDeepLinks;
    delete mockNative.holdDeepLinks;
    delete mockNative.releaseDeepLinks;
    try {
      await LinkFlow.initialize();
      await LinkFlow.holdDeepLinks();
      await LinkFlow.releaseDeepLinks();
      expect(warn).toHaveBeenCalled();
    } finally {
      mockNative.holdDeepLinks = hold;
      mockNative.releaseDeepLinks = release;
      warn.mockRestore();
    }
  });
});

describe('getDiagnostics', () => {
  it('merges native diagnostics with JS state', async () => {
    await LinkFlow.initialize();
    await LinkFlow.holdDeepLinks();
    const d = await LinkFlow.getDiagnostics();
    expect(d).toMatchObject({
      jsSdkVersion: '2.2.0',
      sdkVersion: '2.2.0',
      apiHost: 'thelinkflow.app',
      lastResolveResult: 'organic',
      jsDeepLinksHeld: true,
      nativeLinkForwarding: false,
      initialized: true,
      nativeDiagnosticsAvailable: true,
    });
  });

  it('works before initialize and on a stale native build', async () => {
    const d = await LinkFlow.getDiagnostics();
    expect(d.initialized).toBe(false);
    expect(d.nativeDiagnosticsAvailable).toBe(false);
    expect(mockNative.getDiagnostics).not.toHaveBeenCalled();
  });
});

describe('handleAppLaunch', () => {
  it('passes the launch URL to native so its click_token reaches attribution', async () => {
    (Linking.getInitialURL as jest.Mock).mockResolvedValueOnce(
      'https://go.example.com/AbC123?click_token=tok123'
    );
    await LinkFlow.initialize();
    await LinkFlow.handleAppLaunch();
    expect(mockNative.handleAppLaunch).toHaveBeenCalledWith(
      'https://go.example.com/AbC123?click_token=tok123'
    );
  });

  it('passes null when there is no launch URL, so native can use one it captured itself', async () => {
    await LinkFlow.initialize();
    await LinkFlow.handleAppLaunch();
    expect(mockNative.handleAppLaunch).toHaveBeenCalledWith(null);
  });
});

describe('native link forwarding', () => {
  it('JS forwards Linking URLs to native by default', async () => {
    await LinkFlow.initialize();
    expect(Linking.addEventListener).toHaveBeenCalledWith('url', expect.any(Function));
  });

  it('JS skips its Linking listener when the app forwards links natively', async () => {
    mockNative.nativeLinkForwarding = true;
    await LinkFlow.initialize();
    expect(Linking.addEventListener).not.toHaveBeenCalled();
  });
});

describe('DeepLinkBus', () => {
  const link = (url: string) => directLink(url);

  it('delivers immediately when not held', () => {
    const bus = new DeepLinkBus();
    const got: string[] = [];
    bus.subscribe((l) => got.push(l.url!));
    bus.publish(link('myapp://a'));
    expect(got).toEqual(['myapp://a']);
  });

  it('holds the latest link per type and releases in arrival order', () => {
    const bus = new DeepLinkBus();
    const got: string[] = [];
    bus.subscribe((l) => got.push(l.type + ':' + (l.url ?? l.deepLinkValue)));
    bus.hold();
    bus.publish(link('myapp://1'));
    bus.publish({ type: 'deferred', deepLinkValue: '/promo', params: {} });
    bus.publish(link('myapp://2'));
    expect(got).toEqual([]);
    expect(bus.heldCount()).toBe(2);
    bus.release();
    expect(got).toEqual(['deferred:/promo', 'direct:myapp://2']);
  });

  it('keeps links that arrive before any subscriber', () => {
    const bus = new DeepLinkBus();
    bus.publish({ type: 'deferred', deepLinkValue: '/early', params: {} });
    const got: string[] = [];
    bus.subscribe((l) => got.push(l.deepLinkValue!));
    expect(got).toEqual(['/early']);
  });

  it('suppresses the SDK echo of a URL the router already handled, once, within the TTL', () => {
    let now = 1000;
    const bus = new DeepLinkBus(() => now);
    const got: string[] = [];
    bus.subscribe((l) => got.push(l.url!));
    bus.markRouted('myapp://x');
    bus.publish(link('myapp://x'));
    bus.publish(link('myapp://x'));
    expect(got).toEqual(['myapp://x']);

    bus.markRouted('myapp://y');
    now += 60_000;
    bus.publish(link('myapp://y'));
    expect(got).toEqual(['myapp://x', 'myapp://y']);
  });

  it('parses query parameters', () => {
    expect(queryParams('myapp://p?a=1&b=two%20words&c#frag')).toEqual({
      a: '1',
      b: 'two words',
      c: '',
    });
  });
});

describe('LinkFlow feeds the gate from native events', () => {
  it('publishes deferred links only for attributed results carrying a link', async () => {
    await LinkFlow.initialize();
    const got: any[] = [];
    const unsubscribe = deepLinkBus.subscribe((l) => got.push(l));

    emit('LinkFlowAttribution', { attributed: false });
    emit('LinkFlowAttribution', { attributed: true, deepLinkParams: {} });
    emit('LinkFlowAttribution', {
      attributed: true,
      deepLinkParams: { deep_link_value: '/promo' },
      match: { method: 'click_token', confidence: 1 },
    });
    emit('LinkFlowDeepLink', { url: 'myapp://item/7' });

    expect(got.map((l) => l.type)).toEqual(['deferred', 'direct']);
    expect(got[0].attribution.match.method).toBe('click_token');
    unsubscribe();
  });
});

describe('Expo Router adapter', () => {
  const options = { domains: ['go.example.com'], schemes: ['myapp'] };

  it('maps values to router paths', () => {
    expect(valueToPath('/product/1')).toBe('/product/1');
    expect(valueToPath('myapp://product/1?x=2')).toBe('/product/1?x=2');
    expect(valueToPath('https://shop.example.com/p/9')).toBe('/p/9');
    expect(valueToPath('promo')).toBe('/promo');
  });

  it('recognises short links on LinkFlow domains only', () => {
    expect(shortLinkCode('https://thelinkflow.app/r/AbC123', options)).toBe('AbC123');
    expect(shortLinkCode('https://go.example.com/AbC123', options)).toBe('AbC123');
    expect(shortLinkCode('https://other.example.com/AbC123', options)).toBeNull();
    expect(shortLinkCode('https://go.example.com/a/b/c', options)).toBeNull();
  });

  it('maps deep link params and drops tracking parameters', () => {
    expect(
      deepLinkToPath(
        directLink('https://go.example.com/x?deep_link_value=%2Fproduct%2F1&color=red&utm_source=ig&click_token=t'),
        options
      )
    ).toBe('/product/1?color=red');
    expect(
      deepLinkToPath({ type: 'deferred', params: { path: 'promo/spring' } }, options)
    ).toBe('/promo/spring');
    expect(deepLinkToPath(directLink('https://go.example.com/AbC123'), options)).toBeNull();
  });

  it('honours a custom mapper', () => {
    const mapped = deepLinkToPath(
      { type: 'deferred', params: { sku: 'A1' } },
      { ...options, mapDeepLink: (l) => (l.params.sku ? `/sku/${l.params.sku}` : undefined) }
    );
    expect(mapped).toBe('/sku/A1');
  });

  it('leaves unrelated URLs alone', async () => {
    const redirect = createLinkFlowRedirectSystemPath(options);
    await expect(redirect({ path: 'https://example.org/x', initial: false })).resolves.toBe(
      'https://example.org/x'
    );
    await expect(redirect({ path: '/already/a/path', initial: true })).resolves.toBe(
      '/already/a/path'
    );
  });

  it('routes LinkFlow links and suppresses the SDK echo', async () => {
    const redirect = createLinkFlowRedirectSystemPath(options);
    const url = 'https://go.example.com/x?deep_link_value=/product/1';
    await expect(redirect({ path: url, initial: true })).resolves.toBe('/product/1');

    const got: string[] = [];
    const unsubscribe = deepLinkBus.subscribe((l) => got.push(l.url!));
    deepLinkBus.publish(directLink(url));
    expect(got).toEqual([]);
    unsubscribe();
  });

  it('returns the fallback while held and for unresolved short links', async () => {
    const redirect = createLinkFlowRedirectSystemPath({ ...options, fallbackPath: '/home' });
    await expect(
      redirect({ path: 'https://go.example.com/AbC123', initial: false })
    ).resolves.toBe('/home');

    await LinkFlow.holdDeepLinks();
    await expect(
      redirect({ path: 'myapp://product/1', initial: false })
    ).resolves.toBe('/home');
    await LinkFlow.releaseDeepLinks();
  });

  it('lets Expo Router handle plain custom-scheme links itself', async () => {
    const redirect = createLinkFlowRedirectSystemPath(options);
    await expect(redirect({ path: 'myapp://product/1', initial: false })).resolves.toBe(
      '/product/1'
    );
  });

  it('resolves short links through /api/links/resolve when enabled', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'AbC123', params: { deep_link_value: '/promo', ref: 'x' } }),
    });
    const redirect = createLinkFlowRedirectSystemPath({
      ...options,
      resolveShortLinks: true,
      apiBaseURL: 'https://api.example.com/',
      fetchImpl: fetchImpl as any,
    });
    await expect(
      redirect({ path: 'https://go.example.com/AbC123', initial: false })
    ).resolves.toBe('/promo?ref=x');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/api/links/resolve/AbC123',
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });

  it('falls back when the resolve fails', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(
      resolveLinkFlowPath(directLink('https://go.example.com/Gone1'), {
        ...options,
        resolveShortLinks: true,
        fetchImpl: fetchImpl as any,
      })
    ).resolves.toBeNull();
  });
});

describe('useLinkFlowDeepLink', () => {
  function Probe({ onLink }: { onLink: (l: LinkFlowRoutedDeepLink) => void }) {
    useLinkFlowDeepLink(onLink);
    return null;
  }

  it('delivers mapped links, honouring hold/release', async () => {
    configureLinkFlowRouter({ schemes: ['myapp'] });
    const got: LinkFlowRoutedDeepLink[] = [];
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe onLink={(l) => got.push(l)} />);
    });

    await LinkFlow.holdDeepLinks();
    deepLinkBus.publish({ type: 'deferred', deepLinkValue: '/welcome', params: {} });
    await act(flush);
    expect(got).toEqual([]);

    await act(async () => {
      await LinkFlow.releaseDeepLinks();
      await flush();
    });
    expect(got.map((l) => l.path)).toEqual(['/welcome']);

    await act(async () => {
      deepLinkBus.publish(directLink('myapp://item/7'));
      await flush();
    });
    expect(got.map((l) => l.path)).toEqual(['/welcome', '/item/7']);

    await act(async () => renderer!.unmount());
  });

  it('delivers a link that arrived before the hook mounted', async () => {
    deepLinkBus.publish({ type: 'deferred', deepLinkValue: '/early', params: {} });
    const got: LinkFlowRoutedDeepLink[] = [];
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe onLink={(l) => got.push(l)} />);
      await flush();
    });
    expect(got.map((l) => l.path)).toEqual(['/early']);
    await act(async () => renderer!.unmount());
  });
});
