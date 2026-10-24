import { createVisitSession, type AccountScope, type VisitSession } from '@knowscroll/client-core';
import { useMountedResource } from '../../platform/use-mounted-resource';
import { createVisitMapSession, type VisitMapSession } from './visit-map-session';

/** One visit's data session and map session, for as long as the screen is mounted on this scope and handle. */
export function useVisitSessions(
  scope: AccountScope,
  handle: string,
): { readonly visit: VisitSession; readonly map: VisitMapSession } | undefined {
  return useMountedResource(scope, handle, (own) => {
    const visit = createVisitSession({ scope: own, target: { kind: 'handle', handle } });
    const map = createVisitMapSession({ refresh: () => visit.read() });
    // Leaving drops the list: nothing of a visit is kept (U06 "Nothing from it is kept on your side").
    return {
      value: { visit, map },
      dispose: () => {
        visit.dispose();
        map.end();
      },
    };
  });
}
