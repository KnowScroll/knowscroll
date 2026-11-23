import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { useAccountScope } from './account-scope';

/**
 * Whether the Scrolls made to order ("You asked", "What if", "Another perspective") are switched on in this world (D-436).
 * `unknown`: the API has not answered yet. `off`: it said they are off, it failed, or nobody is signed in. `on`: it said they are
 * on. A screen shows a way into these features only on `on`, so nothing appears and then disappears while the answer is on its
 * way, and a failed answer is the same as "off".
 */
export type MadeToOrderState = 'unknown' | 'on' | 'off';

/** The default is `off`, so a screen rendered with no provider (a test, a gallery) shows no way in. */
export const MadeToOrderContext = createContext<MadeToOrderState>('off');

/** How long an answer stands before it is read again. The switch changes only when the API restarts, so a minute is generous. */
const FEATURES_STALE_MS = 60_000;

/**
 * Reads `GET /v1/account/features` for the signed-in scope and gives the answer to every screen below. The API is the one
 * source of truth: the app has no switch of its own. The read is per scope (it is keyed by the scope and dropped with it), carries
 * nothing personal and creates no work.
 */
export function MadeToOrderProvider({ children }: { readonly children: ReactNode }) {
  const { state } = useAccountScope();
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  const features = useQuery({
    queryKey: scope?.queryKey('account', 'features') ?? ['made-to-order', 'signed-out'],
    queryFn: () => scope!.api.account.features(),
    enabled: scope?.active === true,
    staleTime: FEATURES_STALE_MS,
    retry: false,
  });
  const value: MadeToOrderState =
    scope === undefined
      ? 'off'
      : features.isError
        ? 'off'
        : features.data === undefined
          ? 'unknown'
          : features.data.madeToOrder
            ? 'on'
            : 'off';
  return <MadeToOrderContext.Provider value={value}>{children}</MadeToOrderContext.Provider>;
}

/** What the API said about the made-to-order features: use it where a screen must wait for the answer (a deep link). */
export function useMadeToOrderState(): MadeToOrderState {
  return useContext(MadeToOrderContext);
}

/** True only when the API said the made-to-order Scrolls are on. Every way into them is drawn only while this is true. */
export function useMadeToOrder(): boolean {
  return useContext(MadeToOrderContext) === 'on';
}
