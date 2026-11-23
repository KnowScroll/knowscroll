import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useAccountScopeIfPresent } from './account-scope';

/**
 * Whether the Scrolls made to order ("You asked", "What if", "Another perspective") are switched on in this world (D-436).
 * `unknown`: the API has not answered yet. `off`: it said they are off, it failed, or nobody is signed in. `on`: it said they are
 * on. A screen shows a way into these features only on `on`, so nothing appears and then disappears while the answer is on its
 * way, and a failed answer is the same as "off".
 */
export type MadeToOrderState = 'unknown' | 'on' | 'off';

/**
 * A way to set the state without the API (the gallery, a test). The default, `undefined`, means "ask the API": the hook below
 * reads `GET /v1/account/features` itself, and only on a screen that can show a way in. Nothing at the app root reads it, so a
 * screen that has no such way in makes no such request.
 */
export const MadeToOrderContext = createContext<MadeToOrderState | undefined>(undefined);

/** How long an answer stands before it is read again. The switch changes only when the API restarts, so a minute is generous. */
const FEATURES_STALE_MS = 60_000;

/** Stands in where there is no query client at all (a screen rendered alone): it never reads anything, so it shows no way in. */
const NO_CLIENT = new QueryClient();

/**
 * What the API says about the made-to-order features, read the first time a screen that can show a way in asks, and shared by
 * every such screen under the same scope (one query key, cached per scope and dropped with it, so a second screen makes no second
 * read within the stale time). The API is the one source of truth: the app has no switch of its own. The read carries nothing
 * personal and creates no work. Without a signed-in scope, or without a query client, it never reads and the answer is `off`.
 */
export function useMadeToOrderState(): MadeToOrderState {
  const override = useContext(MadeToOrderContext);
  const { state } = useAccountScopeIfPresent();
  const client = useContext(QueryClientContext);
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  const features = useQuery(
    {
      queryKey: scope?.queryKey('account', 'features') ?? ['made-to-order', 'no-scope'],
      queryFn: () => scope!.api.account.features(),
      enabled: override === undefined && client !== undefined && scope?.active === true,
      staleTime: FEATURES_STALE_MS,
      retry: false,
    },
    client ?? NO_CLIENT,
  );
  if (override !== undefined) return override;
  if (scope === undefined || client === undefined || features.isError) return 'off';
  if (features.data === undefined) return 'unknown';
  return features.data.madeToOrder ? 'on' : 'off';
}

/** True only when the API said the made-to-order Scrolls are on. Every way into them is drawn only while this is true. */
export function useMadeToOrder(): boolean {
  return useMadeToOrderState() === 'on';
}
