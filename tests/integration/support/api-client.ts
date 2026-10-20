import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { apiContract, type ApiContract } from '@knowscroll/contracts';

/**
 * The typed HTTP client a KnowScroll client builds from `@knowscroll/contracts` (oRPC OpenAPI
 * link). The release tests use it as the spike's client; errors are checked with plain `fetch`,
 * because the API answers RFC 9457 problems rather than oRPC's own error shape.
 */
export function apiClient(
  baseUrl: string,
  authorization?: string,
  /** The scope claim (`X-KS-Scope: <accountId>:<epoch>`) every account request carries. */
  scope?: string,
): ContractRouterClient<ApiContract> {
  const link = new OpenAPILink(apiContract, {
    url: baseUrl,
    headers: () => ({
      ...(authorization === undefined ? {} : { authorization }),
      ...(scope === undefined ? {} : { 'x-ks-scope': scope }),
    }),
  });
  return createORPCClient(link);
}
