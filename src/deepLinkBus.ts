import type { AttributionResult } from './index';

/** How a deep link reached the app. */
export type LinkFlowDeepLinkType = 'deferred' | 'direct';

/** A deep link delivered to `useLinkFlowDeepLink` / the Expo Router adapter. */
export interface LinkFlowDeepLink {
  type: LinkFlowDeepLinkType;
  /** The opened URL (direct links). */
  url?: string;
  /** `deepLinkValue` of the attribution result (deferred links), when the server sent one. */
  deepLinkValue?: string;
  /** Deferred: the link's `deepLinkParams`. Direct: the URL's query parameters. */
  params: Record<string, any>;
  /** The full attribution result (deferred links only). */
  attribution?: AttributionResult;
}

type Listener = (link: LinkFlowDeepLink) => void;

/** How long a URL already routed by `redirectSystemPath` suppresses the matching SDK event. */
export const ROUTED_URL_TTL_MS = 30_000;

/**
 * JS-side gate between the native SDK's deep-link events and app code that
 * navigates (the hook and the Expo Router adapter).
 *
 * - **Hold/release:** while held, links are queued (latest per type) and
 *   delivered on release. The native SDK (2.2.0+) holds its own events too.
 *   This layer also covers a stale native build without hold support.
 * - **No subscriber yet:** a link that arrives before any hook mounted is kept
 *   (latest per type) and handed to the first subscriber, so a deferred link
 *   resolved during app start is not lost.
 * - **Routed URLs:** a URL that `redirectSystemPath` already turned into a
 *   route is not delivered again when the SDK echoes it as a direct link.
 */
export class DeepLinkBus {
  private held = false;
  private pending = new Map<LinkFlowDeepLinkType, LinkFlowDeepLink>();
  private undelivered = new Map<LinkFlowDeepLinkType, LinkFlowDeepLink>();
  private listeners = new Set<Listener>();
  private routed = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  hold(): void {
    this.held = true;
    // Links still waiting for a first subscriber are now held too.
    this.undelivered.forEach((link) => putLatest(this.pending, link));
    this.undelivered.clear();
  }

  isHeld(): boolean {
    return this.held;
  }

  heldCount(): number {
    return this.pending.size;
  }

  /** Stops holding and delivers what was queued, in arrival order. */
  release(): void {
    this.held = false;
    const queued = [...this.pending.values()];
    this.pending.clear();
    queued.forEach((link) => this.emit(link));
  }

  publish(link: LinkFlowDeepLink): void {
    if (link.type === 'direct' && link.url && this.consumeRouted(link.url)) {
      return;
    }
    if (this.held) {
      putLatest(this.pending, link);
      return;
    }
    this.emit(link);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.undelivered.size > 0) {
      const queued = [...this.undelivered.values()];
      this.undelivered.clear();
      queued.forEach((link) => listener(link));
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Records that the router already navigated for this URL. */
  markRouted(url: string): void {
    this.prune();
    this.routed.set(url, this.now() + ROUTED_URL_TTL_MS);
  }

  /** Clears hold state and queues (listeners are owned by components and kept). */
  reset(): void {
    this.held = false;
    this.pending.clear();
    this.undelivered.clear();
    this.routed.clear();
  }

  private emit(link: LinkFlowDeepLink): void {
    if (this.listeners.size === 0) {
      putLatest(this.undelivered, link);
      return;
    }
    this.listeners.forEach((listener) => {
      try {
        listener(link);
      } catch (err) {
        console.error('[LinkFlow] deep link listener threw:', err);
      }
    });
  }

  private consumeRouted(url: string): boolean {
    this.prune();
    if (!this.routed.has(url)) return false;
    this.routed.delete(url);
    return true;
  }

  private prune(): void {
    const now = this.now();
    this.routed.forEach((expiry, url) => {
      if (expiry <= now) this.routed.delete(url);
    });
  }
}

function putLatest(
  map: Map<LinkFlowDeepLinkType, LinkFlowDeepLink>,
  link: LinkFlowDeepLink
): void {
  // Delete first so iteration order reflects the latest arrival.
  map.delete(link.type);
  map.set(link.type, link);
}

/** True for an attributed result that carries a deferred deep link payload. */
export function carriesDeepLink(result: AttributionResult | null | undefined): boolean {
  if (!result || !result.attributed) return false;
  return (
    !!result.deepLinkValue ||
    (!!result.deepLinkParams && Object.keys(result.deepLinkParams).length > 0)
  );
}

export function deferredLink(result: AttributionResult): LinkFlowDeepLink {
  return {
    type: 'deferred',
    deepLinkValue: result.deepLinkValue,
    params: result.deepLinkParams ?? {},
    attribution: result,
  };
}

export function directLink(url: string): LinkFlowDeepLink {
  return { type: 'direct', url, params: queryParams(url) };
}

/** Query parameters of a URL without relying on `URL` (incomplete in some RN runtimes). */
export function queryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf('?');
  if (q < 0) return out;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(
        rawValue.replace(/\+/g, ' ')
      );
    } catch {
      out[rawKey] = rawValue;
    }
  }
  return out;
}

/** Process-wide bus used by `LinkFlow`, the hook and the router adapter. */
export const deepLinkBus = new DeepLinkBus();
