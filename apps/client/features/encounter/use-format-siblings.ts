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

type Variants = NonNullable<ReturnType<typeof useOpenedContext>['data']>['variants'];

/**
 * What the switch offers for each format of an explanation, from the variants the server admitted (D-269). A twin that is ready
 * opens, one being made is "preparing", and one that does not exist can be asked for ("requestable", as Explore offers it) when the
 * route has a request to make. A route with none, and a read that has not arrived, leave it "unavailable".
 */
export function siblingAvailability(
  variants: Variants | undefined,
  current: Format,
  canRequest: boolean,
): Record<Format, FormatAvailability> {
  const missing: FormatAvailability = variants !== undefined && canRequest ? 'requestable' : 'unavailable';
  const availability: Record<Format, FormatAvailability> = { reel: missing, scroll: missing };
  for (const variant of variants ?? [])
    availability[variant.kind] =
      variant.status === 'ready' ? 'ready' : variant.status === 'pending' ? 'preparing' : missing;
  availability[current] = 'ready';
  return availability;
}

/**
 * Which formats of this explanation exist, for a Reel or Scroll opened by its address. A direct open
 * returns no format variants; the exposure context does, so the switch reads it. `requestFormat` is
 * the route's way to ask for a twin that does not exist yet (the request sheet); without it a missing
 * twin stays "unavailable". The read shares its cache entry with Explore's, and creates no exposure.
 */
export function useFormatSiblings(
  scope: AccountScope,
  exposureId: string,
  current: Format,
  requestFormat?: (format: Format) => void,
) {
  const router = useRouter();
  const context = useOpenedContext(scope, exposureId);
  const variants = context.data?.variants;
  const availability = siblingAvailability(variants, current, requestFormat !== undefined);
  const assetIds: Partial<Record<Format, string>> = {};
  for (const variant of variants ?? []) if (variant.status === 'ready') assetIds[variant.kind] = variant.assetId;
  /** Opens the twin when it exists, or asks for it when the route can; otherwise does nothing. */
  const select = (to: Format) => {
    const assetId = assetIds[to];
    if (assetId !== undefined) router.push(`/${to}/${assetId}`);
    else if (availability[to] === 'requestable') requestFormat?.(to);
  };
  return { availability, select };
}
