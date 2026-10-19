# @knowscroll/client-core

Client-side cores shared by web, Android and iOS: the typed API client, the TanStack Query client
factory, and the AccountScope (#226: account + privacy epoch ownership of the query client, the
API client, the hint socket and local stores) with the sign-in client. The interaction recorder
arrives with its first journey and will belong to the scope too.

| File | Contents |
|---|---|
| `src/api-client.ts` | `resolveApiOrigin()` (D-008: the page origin on the web; the configured world origin on native, HTTPS only; a development build, `allowDevelopmentHttp: __DEV__`, may also use plain HTTP to localhost / 127.0.0.1 / 10.0.2.2), `createApiClient()` (oRPC `OpenAPILink` over `apiContract`; RFC 9457 problems become `ORPCError`s carrying the problem document), `apiProblem()` |
| `src/query-client.ts` | `createQueryClient()`: commands (mutations) never retry; queries retry at most twice and only for network failures and 5xx, after 1 s and then 2 s (`queryRetryDelay` doubles and would cap at 8 s); `shouldRetryQuery`, `queryRetryDelay`. Also exported alone as `@knowscroll/client-core/query-client`, so the root layout does not pull the API client, contracts, Zod and oRPC into the first chunk |
| `src/health.ts` | `healthQueryOptions(api)`: `GET /health` validated against `HealthResponseSchema`, key `['operations', 'health']` (operations data, not account-scoped) |
| `src/account-scope.ts` | `createAccountScope()`: one scope per `(accountId, privacyEpoch)` (`scopeIdOf`) owning its QueryClient, its API client (`fencedFetch`: requests carry the scope's abort signal; once the scope ended nothing starts and a late response is dropped with `ScopeEndedError`), its socket and its storage (keys `ks.scope.<account>:<epoch>.…`). `end()` closes the socket, aborts and fences in-flight requests, clears the cache and purges the storage, in that order |
| `src/account-scope-manager.ts` | `createAccountScopeManager()`: the single owner of the current scope. `start()` reads the session; `redeem()` (another account → the old scope ends before the new one exists), `refresh()` (a new privacy epoch → a new scope; a refused session → `signed_out: session_ended`), `signOut()` (web: only when the server answered, since only it clears the HttpOnly cookie; native: always drops the secure-store token), `requestLink()`; state `starting · signed_out · unavailable · signed_in` for `useSyncExternalStore` |
| `src/account-scope-socket.ts` | `connectScopeSocket()`: Socket.IO on the API origin (native: bearer in `auth.token`; web: the same-origin cookie), subscribed to the scope's universe; `scope_changed` above the highest revision seen, or `scope_resync`, invalidates the scope's queries; "io server disconnect" makes the manager recheck the session |
| `src/auth-client.ts` | `createAuthClient()`: the `/auth/*` routes as typed outcomes (`requested · invalid_address · rate_limited(retryAfter) · unavailable`, `signed_in · link_invalid · refused · unavailable`), never throwing; anything that is not the contract's answer counts as `unavailable` |

Rules:
- No provider credentials or secrets ever reach this package; the client calls only the API.
- Commands are never resent blindly: an unknown outcome is reconciled through a durable read
  (blueprint §19). Retrying a command belongs to the pending-command queue with stable request
  IDs, not to the query client.
- Account-scoped query keys start with `scope.queryKey(…)` (`['scope', <account>:<epoch>, …]`),
  and every account request goes through `scope.api`; operations keys start with `'operations'`.
- Nothing account-scoped outlives its scope: the app mounts the scope's QueryClient keyed by the
  scope (`apps/client/providers/account-scope.tsx`), so a switch also remounts the screens.

The package exports its TypeScript sources. Its tests (`src/**/*.test.ts`, Vitest, labelled test
doubles for `fetch`) run in CI only: `pnpm --filter @knowscroll/client-core test`.
