import type { ProblemCode, ResumeResponse } from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { NavigationPorts } from './navigation-ports.js';
import { ref, scopeCode } from './navigation-support.js';

/** How many of the caller's most recent Scroll openings are looked at, and how far back (D-216). */
export const RESUME_WINDOW = { limit: 8, days: 30 } as const;

export interface ResumePorts extends Pick<
  NavigationPorts,
  | 'withPersonalScope'
  | 'readContextBase'
  | 'readExactEncounter'
  | 'readContinuations'
  | 'readSeriesTotal'
  | 'readHidden'
> {
  /** The caller's own activated Scroll exposures, newest first, within the window. */
  readonly readRecentExposures: (
    scope: PersonalScopeTx,
    query: { readonly limit: number; readonly days: number },
  ) => Promise<readonly string[]>;
  /** Which of these assets the caller has opened and activated (`READ_VISITED_ASSETS`). */
  readonly readVisitedAssets: (scope: PersonalScopeTx, assetIds: readonly string[]) => Promise<ReadonlySet<string>>;
}

export type ReadResumeResult =
  | { readonly kind: 'read'; readonly resume: ResumeResponse['resume'] }
  | { readonly kind: 'refused'; readonly code: ProblemCode };
export type ReadResume = (authority: PersonalAuthority) => Promise<ReadResumeResult>;

/**
 * `POST /v1/experience/resume/read`: the next Part of a series the caller has started and not yet
 * opened, the thing "continue where you were" offers on the Universe (D-216).
 *
 * Authority: the caller's own personal scope. It reads only the caller's own opened Scrolls and the
 * admitted series, so it names no other person's position and no place inside a Scroll. Newest
 * opening first: the first whose series has a next Part the caller has not opened, that is not
 * hidden and is still admitted, is the answer. Writes nothing, opens nothing and enqueues nothing;
 * opening the Part is the client's own `direct` open, like any address. Not evidence of anything.
 */
export function makeReadResume(p: ResumePorts): ReadResume {
  return async (authority) => {
    const entered = await p.withPersonalScope(authority, async (scope) => {
      for (const exposureId of await p.readRecentExposures(scope, RESUME_WINDOW)) {
        const next = await nextPartOf(p, scope, exposureId);
        if (next) return next;
      }
      return null;
    });
    return entered.kind === 'entered'
      ? { kind: 'read', resume: entered.value }
      : { kind: 'refused', code: scopeCode(entered.refusal.kind) };
  };
}

async function nextPartOf(
  p: ResumePorts,
  scope: PersonalScopeTx,
  exposureId: string,
): Promise<ResumeResponse['resume']> {
  const base = await p.readContextBase(scope, exposureId);
  if (!base) return null;
  const link = (await p.readContinuations(scope, base.ref)).find(
    (candidate) => candidate.direction === 'next' && candidate.relation.kind === 'series_step',
  );
  if (!link) return null;
  const target = await p.readExactEncounter(scope, { ...ref(link.target), capabilities: base.capabilities });
  if (!target?.series) return null;
  if ((await p.readHidden(scope, [target.assetId])).length > 0) return null;
  if ((await p.readVisitedAssets(scope, [target.assetId])).size > 0) return null;
  const total = await p.readSeriesTotal(scope, target.series);
  if (total === undefined || target.series.part > total) return null;
  return { assetId: target.assetId, title: target.metadata.title, part: target.series.part, total };
}
