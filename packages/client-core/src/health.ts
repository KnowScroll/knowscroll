import { queryOptions } from '@tanstack/react-query';
import { HealthResponseSchema } from '@knowscroll/contracts';
import type { ApiClient } from './api-client';

/** Query key of `GET /health`. Operations data, so not account-scoped. */
export const healthQueryKey = ['operations', 'health'] as const;

/**
 * `GET /health` for the app's developer diagnostics: the world, commit, artifact and newest
 * migration the API reports. The answer is validated against the contract schema.
 */
export function healthQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: healthQueryKey,
    queryFn: async ({ signal }) => HealthResponseSchema.parse(await api.health(undefined, { signal })),
    staleTime: 0,
  });
}
