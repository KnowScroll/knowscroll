import type { InvalidateOwnAccountAccess } from '../public.js';
import type { AccountLifecyclePorts } from './ports.js';

const MAX_COUNTER = 2_147_483_647;

/** Monotonic access barrier, not a clearing/deletion executor or completion receipt.
 * The scope retains its frozen old epoch; follow-on work must enter a fresh scope.
 */
export function makeInvalidateOwnAccountAccess(ports: AccountLifecyclePorts): InvalidateOwnAccountAccess {
  return (authority, mode) =>
    ports.withScope(authority, async (scope) => {
      const fenced = await ports.fenceOwn(scope);
      if (fenced.kind === 'unavailable') return fenced;
      if (fenced.owner.privacyEpoch >= MAX_COUNTER || scope.revisionAtEntry >= MAX_COUNTER)
        return { kind: 'counter_exhausted' };
      return ports.advance(scope, mode);
    });
}
