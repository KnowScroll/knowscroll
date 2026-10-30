import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { AccountScope } from '@knowscroll/client-core';
import type { FormatAvailability } from '@knowscroll/ui';

type Format = 'reel' | 'scroll';

/**
 * What the server admitted around a Scroll or Reel opened by its address: its formats, its series and the moves on.
 * A direct open returns none of it; the exposure context does. The read shares its cache entry with Explore's
 * and creates no exposure.
 */
export function useOpenedContext(scope: AccountScope, exposureId: string) {
  return useQuery({
    queryKey: scope.queryKey('encounter', 'context', exposureId),
    queryFn: () => scope.api.experience.exposureContext({ exposureId }),
    staleTime: Infinity,
  });
}

/**
 * Which formats of this explanation exist, for a Reel or Scroll opened by its address. A direct open
 * returns no format variants; the exposure context does, so the switch reads it. A missing twin stays
 * "unavailable" here: a direct route has no request flow. The read shares its cache entry with
 * Explore's, and creates no exposure.
 */
export function useFormatSiblings(scope: AccountScope, exposureId: string, current: Format) {
  const router = useRouter();
  const context = useOpenedContext(scope, exposureId);
  const availability: Record<Format, FormatAvailability> = { reel: 'unavailable', scroll: 'unavailable' };
  const assetIds: Partial<Record<Format, string>> = {};
  for (const variant of context.data?.variants ?? []) {
    availability[variant.kind] =
      variant.status === 'ready' ? 'ready' : variant.status === 'pending' ? 'preparing' : 'unavailable';
    if (variant.status === 'ready') assetIds[variant.kind] = variant.assetId;
  }
  availability[current] = 'ready';
  /** Opens the twin when it exists. A direct route has no request flow, so a missing one does nothing. */
  const select = (to: Format) => {
    const assetId = assetIds[to];
    if (assetId !== undefined) router.push(`/${to}/${assetId}`);
  };
  return { availability, select };
}
