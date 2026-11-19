import { useEffect, useRef, useState } from 'react';

import { deepLinkBus } from './deepLinkBus';
import type { LinkFlowDeepLink } from './deepLinkBus';
import { resolveLinkFlowPath } from './expoRouter';

/** A deep link plus the router path it maps to (`null` when unmapped). */
export interface LinkFlowRoutedDeepLink extends LinkFlowDeepLink {
  path: string | null;
}

/**
 * Subscribes to LinkFlow deep links (2.2.0+): the deferred deep link resolved
 * after install and direct links opened while the app runs.
 *
 * Honours `LinkFlow.holdDeepLinks()`: nothing is delivered while held, and the
 * latest link of each type arrives on `releaseDeepLinks()`. A link that arrived
 * before the first component using this hook mounted is delivered on mount.
 * Links that `redirectSystemPath` already routed are not delivered again.
 *
 * ```tsx
 * const router = useRouter();
 * useLinkFlowDeepLink((link) => {
 *   if (link.path) router.push(link.path);
 * });
 * ```
 *
 * @returns the most recent link, or null.
 */
export function useLinkFlowDeepLink(
  onDeepLink?: (link: LinkFlowRoutedDeepLink) => void
): LinkFlowRoutedDeepLink | null {
  const [latest, setLatest] = useState<LinkFlowRoutedDeepLink | null>(null);
  const handler = useRef(onDeepLink);
  handler.current = onDeepLink;

  useEffect(() => {
    let active = true;
    const unsubscribe = deepLinkBus.subscribe((link) => {
      resolveLinkFlowPath(link)
        .catch(() => null)
        .then((path) => {
          if (!active) return;
          const routed: LinkFlowRoutedDeepLink = { ...link, path };
          setLatest(routed);
          handler.current?.(routed);
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return latest;
}
