# @knowscroll/client-core

Client-side cores shared by web, Android and iOS. This first version holds the typed API client
and the TanStack Query client factory; the AccountScope (account + privacy epoch ownership of
the query client, socket, recorder and stores) arrives with identity (#226), and the interaction
recorder with its first journey.

| File | Contents |
|---|---|
| `src/api-client.ts` | `resolveApiOrigin()` (D-008: the page origin on the web; the configured world origin on native, HTTPS only; a development build, `allowDevelopmentHttp: __DEV__`, may also use plain HTTP to localhost / 127.0.0.1 / 10.0.2.2), `createApiClient()` (oRPC `OpenAPILink` over `apiContract`; RFC 9457 problems become `ORPCError`s carrying the problem document), `apiProblem()` |
| `src/query-client.ts` | `createQueryClient()`: commands (mutations) never retry; queries retry at most twice and only for network failures and 5xx, after 1 s and then 2 s (`queryRetryDelay` doubles and would cap at 8 s); `shouldRetryQuery`, `queryRetryDelay`. Also exported alone as `@knowscroll/client-core/query-client`, so the root layout does not pull the API client, contracts, Zod and oRPC into the first chunk |
| `src/health.ts` | `healthQueryOptions(api)`: `GET /health` validated against `HealthResponseSchema`, key `['operations', 'health']` (operations data, not account-scoped) |

Rules:
- No provider credentials or secrets ever reach this package; the client calls only the API.
- Commands are never resent blindly: an unknown outcome is reconciled through a durable read
  (blueprint §19). Retrying a command belongs to the pending-command queue with stable request
  IDs, not to the query client.
- Account-scoped query keys start with the scope once the AccountScope exists; operations keys
  start with `'operations'`.

The package exports its TypeScript sources. Its tests (`src/**/*.test.ts`, Vitest, labelled test
doubles for `fetch`) run in CI only: `pnpm --filter @knowscroll/client-core test`.
