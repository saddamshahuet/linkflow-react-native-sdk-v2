/**
 * Expo Router adapter (2.2.0+).
 *
 * Expo Router calls `redirectSystemPath({ path, initial })` from
 * `app/+native-intent.tsx` for every URL the OS hands the app. This module
 * turns LinkFlow links into router paths, and honours `LinkFlow.holdDeepLinks()`.
 * It does not import `expo-router`, so the SDK has no dependency on it.
 *
 * ```ts
 * // app/+native-intent.tsx
 * import { createLinkFlowRedirectSystemPath } from '@linkflow/react-native-sdk';
 * export const redirectSystemPath = createLinkFlowRedirectSystemPath({
 *   domains: ['go.example.com'],
 *   schemes: ['myapp'],
 * });
 * ```
 */
import { deepLinkBus, directLink } from './deepLinkBus';
import type { LinkFlowDeepLink } from './deepLinkBus';

export interface LinkFlowRouterOptions {
  /**
   * Hosts of your LinkFlow links, e.g. your custom link domain
   * (`go.example.com`). `thelinkflow.app` is always included.
   */
  domains?: string[];
  /** Your app's custom URL schemes (e.g. `myapp`). */
  schemes?: string[];
  /**
   * Custom mapping from a deep link to a router path. Return a path to use it,
   * `null` for "no route", or `undefined` to fall back to the default mapping.
   */
  mapDeepLink?: (link: LinkFlowDeepLink) => string | null | undefined;
  /**
   * Parameter names read, in order, for the destination when there is no
   * `deepLinkValue`. Default: `deep_link_value`, `deepLinkValue`, `path`.
   */
  pathParams?: string[];
  /**
   * Path returned while deep links are held, or when a LinkFlow short link
   * cannot be mapped synchronously. The link is delivered to
   * `useLinkFlowDeepLink` later. Default `/`.
   */
  fallbackPath?: string;
  /**
   * Resolve short links (`https://go.example.com/AbC123`) to their deep link
   * params via `GET /api/links/resolve/{code}`. Off by default. The server
   * records a click for each resolve, as it does for a browser redirect.
   */
  resolveShortLinks?: boolean;
  /** API base URL used to resolve short links. Default `https://thelinkflow.app`. */
  apiBaseURL?: string;
  /** Timeout for a short-link resolve, in ms. Default 3000. */
  resolveTimeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_HOST = 'thelinkflow.app';
const DEFAULT_PATH_PARAMS = ['deep_link_value', 'deepLinkValue', 'path'];
/** Query parameters LinkFlow adds for attribution; never forwarded to the route. */
const TRACKING_PARAMS = /^(click_token|lf_[a-z_]*|utm_[a-z_]*)$/i;

let current: LinkFlowRouterOptions = {};

/** Sets the options shared by `redirectSystemPath` and `useLinkFlowDeepLink`. */
export function configureLinkFlowRouter(options: LinkFlowRouterOptions): void {
  current = { ...options };
}

export function getLinkFlowRouterOptions(): LinkFlowRouterOptions {
  return current;
}

interface ParsedUrl {
  scheme: string;
  host: string;
  path: string;
  query: string;
}

function parseUrl(url: string): ParsedUrl | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(url.trim());
  if (!m) return null;
  const host = (m[2] ?? '').replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
  return { scheme: m[1]!.toLowerCase(), host, path: m[3] ?? '', query: m[4] ?? '' };
}

export type LinkFlowUrlKind =
  /** A link on a LinkFlow domain (short link or a link carrying a deep link value). */
  | 'linkflow'
  /** One of the app's own custom schemes. */
  | 'scheme'
  /** Anything else: left alone. */
  | 'other';

export function classifyUrl(url: string, options: LinkFlowRouterOptions = current): LinkFlowUrlKind {
  const parsed = parseUrl(url);
  if (!parsed) return 'other';
  if (parsed.scheme === 'http' || parsed.scheme === 'https') {
    const domains = [DEFAULT_HOST, ...(options.domains ?? [])].map((d) => d.toLowerCase());
    return domains.includes(parsed.host) ? 'linkflow' : 'other';
  }
  const schemes = (options.schemes ?? []).map((s) => s.toLowerCase());
  return schemes.includes(parsed.scheme) ? 'scheme' : 'other';
}

/**
 * The short-link code in a LinkFlow URL: `https://thelinkflow.app/r/{code}`,
 * or `https://<custom domain>/{code}`. Null when the URL is not a short link.
 */
export function shortLinkCode(url: string, options: LinkFlowRouterOptions = current): string | null {
  if (classifyUrl(url, options) !== 'linkflow') return null;
  const segments = parseUrl(url)!.path.split('/').filter(Boolean);
  if (segments.length === 2 && (segments[0] === 'r' || segments[0] === 'c')) {
    return validCode(segments[1]!);
  }
  if (segments.length === 1) return validCode(segments[0]!);
  return null;
}

function validCode(code: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null;
}

/** Turns a destination value (path, custom-scheme URL or web URL) into a router path. */
export function valueToPath(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('/')) return v;
  const parsed = parseUrl(v);
  if (parsed) {
    if (parsed.scheme === 'http' || parsed.scheme === 'https') {
      return (parsed.path || '/') + parsed.query;
    }
    // Custom scheme: Expo Router treats the host as the first path segment.
    const path = '/' + [parsed.host, ...parsed.path.split('/')].filter(Boolean).join('/');
    return path + parsed.query;
  }
  return '/' + v;
}

function appendQuery(path: string, params: Record<string, any>, skip: string[]): string {
  const pairs = Object.entries(params)
    .filter(([k, v]) => !skip.includes(k) && !TRACKING_PARAMS.test(k) && v != null && typeof v !== 'object')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (pairs.length === 0) return path;
  return path + (path.includes('?') ? '&' : '?') + pairs.join('&');
}

/**
 * Default, synchronous mapping of a deep link to a router path. Null when the
 * link carries no destination (e.g. a short link that still needs resolving).
 */
export function deepLinkToPath(
  link: LinkFlowDeepLink,
  options: LinkFlowRouterOptions = current
): string | null {
  if (options.mapDeepLink) {
    const custom = options.mapDeepLink(link);
    if (custom !== undefined) return custom;
  }
  const pathParams = options.pathParams ?? DEFAULT_PATH_PARAMS;
  const params = link.params ?? {};

  if (link.deepLinkValue) {
    const path = valueToPath(link.deepLinkValue);
    return path && appendQuery(path, params, pathParams);
  }
  for (const key of pathParams) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) {
      const path = valueToPath(value);
      return path && appendQuery(path, params, pathParams);
    }
  }
  // A custom-scheme URL is itself a destination; a LinkFlow web link is not.
  if (link.url && classifyUrl(link.url, options) === 'scheme') {
    const path = valueToPath(link.url.split('?')[0]!);
    return path && appendQuery(path, params, []);
  }
  return null;
}

/** Fetches a short link's params from `GET /api/links/resolve/{code}`. */
export async function resolveShortLink(
  code: string,
  options: LinkFlowRouterOptions = current
): Promise<Record<string, any> | null> {
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return null;
  const base = (options.apiBaseURL ?? `https://${DEFAULT_HOST}`).replace(/\/+$/, '');
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), options.resolveTimeoutMs ?? 3000);
  try {
    const res = await doFetch(`${base}/api/links/resolve/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return body && typeof body.params === 'object' && body.params !== null ? body.params : {};
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a deep link to a router path, resolving short links over the network
 * when `resolveShortLinks` is on.
 */
export async function resolveLinkFlowPath(
  link: LinkFlowDeepLink,
  options: LinkFlowRouterOptions = current
): Promise<string | null> {
  const path = deepLinkToPath(link, options);
  if (path || !link.url || !options.resolveShortLinks) return path;
  const code = shortLinkCode(link.url, options);
  if (!code) return null;
  const params = await resolveShortLink(code, options);
  if (!params) return null;
  return deepLinkToPath({ ...link, params: { ...link.params, ...params } }, options);
}

export interface RedirectSystemPathEvent {
  path: string;
  initial: boolean;
}

/**
 * Builds the `redirectSystemPath` export for `app/+native-intent.tsx`.
 *
 * - Not a LinkFlow link or one of your schemes: returned unchanged.
 * - Deep links held (`LinkFlow.holdDeepLinks()`): returns `fallbackPath`; the
 *   link is delivered to `useLinkFlowDeepLink` on release.
 * - Otherwise: the mapped route. Expo Router navigates there, and the SDK's
 *   own echo of the same URL is not delivered to the hook again.
 *
 * Never throws: on an unexpected error the original path is returned.
 */
export function createLinkFlowRedirectSystemPath(
  options?: LinkFlowRouterOptions
): (event: RedirectSystemPathEvent) => Promise<string> {
  if (options) configureLinkFlowRouter(options);
  return async ({ path }: RedirectSystemPathEvent): Promise<string> => {
    const opts = current;
    const fallback = opts.fallbackPath ?? '/';
    try {
      const kind = classifyUrl(path, opts);
      if (kind === 'other') return path;
      if (deepLinkBus.isHeld()) return fallback;

      const route = await resolveLinkFlowPath(directLink(path), opts);
      if (route) {
        deepLinkBus.markRouted(path);
        return route;
      }
      if (kind === 'scheme') {
        // Let Expo Router apply its own scheme handling.
        deepLinkBus.markRouted(path);
        return path;
      }
      return fallback;
    } catch (err) {
      console.warn('[LinkFlow] redirectSystemPath failed; leaving the path unchanged', err);
      return path;
    }
  };
}
