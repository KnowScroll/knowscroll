import { FENCE_OWN_ACCOUNT, type FenceOwnAccount, type WithPersonalScope } from '../../identity/public.js';
import { LOCK_KEEP_POSITION_TARGET, type LockKeepPositionTarget } from '../../content/public.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import { makeReadKeepEntry, makeSetKeepPlace } from '../application/keep-place.js';
import type { KeepPorts } from '../application/keep-ports.js';
import { KEEP_PLACE_USE_CASES, type KeepPlaceUseCases } from '../public.js';
import { keepStore } from './keep-store.js';
/** Explicit opt-in factory; no application/HTTP composition is changed by this prerequisite. */
export function keepPlaceUseCases(
  deps: Pick<KeepPorts, 'withScope' | 'fenceOwn' | 'target'> &
    Partial<Pick<KeepPorts, 'store' | 'now' | 'advance' | 'notify'>>,
): KeepPlaceUseCases {
  const ports: KeepPorts = {
    ...deps,
    store: deps.store ?? keepStore,
    advance: deps.advance ?? advanceScopeRevision,
    notify: deps.notify ?? notifyScopeChanged,
    now: deps.now ?? (() => new Date()),
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
  };
  return { readEntry: makeReadKeepEntry(ports), setPlace: makeSetKeepPlace(ports) };
}
export function keepPlaceProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: KEEP_PLACE_USE_CASES,
      inject: [tokens.withPersonalScope, FENCE_OWN_ACCOUNT, LOCK_KEEP_POSITION_TARGET],
      useFactory: (withScope: WithPersonalScope, fenceOwn: FenceOwnAccount, target: LockKeepPositionTarget) =>
        keepPlaceUseCases({ withScope, fenceOwn, target }),
    },
  ];
}
export { keepStore } from './keep-store.js';
export type { KeepPorts, KeepStore } from '../application/keep-ports.js';
