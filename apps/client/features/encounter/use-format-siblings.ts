import { useQuery } from '@tanstack/react-query';
import type { AccountScope } from '@knowscroll/client-core';
import type { FormatAvailability } from '@knowscroll/ui';

type Format = 'reel' | 'scroll';

/**
 * Which formats of this explanation exist, for a Reel or Scroll opened by its address. A direct open
 * returns no format variants; the exposure context does, so the switch reads it. A missing twin stays
 * "unavailable" here: a direct route has no request flow. The read shares its cache entry with
 * Explore's, and creates no exposure.
 */
export function useFormatSiblings(scope: AccountScope, exposureId: string, current: Format) {
  const context = useQuery({
    queryKey: scope.queryKey('encounter', 'context', exposureId),
    queryFn: () => scope.api.experience.exposureContext({ exposureId }),
    staleTime: Infinity,
  });
  const availability: Record<Format, FormatAvailability> = { reel: 'unavailable', scroll: 'unavailable' };
  const assetIds: Partial<Record<Format, string>> = {};
  for (const variant of context.data?.variants ?? []) {
    availability[variant.kind] =
      variant.status === 'ready' ? 'ready' : variant.status === 'pending' ? 'preparing' : 'unavailable';
    if (variant.status === 'ready') assetIds[variant.kind] = variant.assetId;
  }
  availability[current] = 'ready';
  return { availability, assetIds };
}
