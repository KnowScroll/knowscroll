import type { InterestLeads, InterestRollups, ReadInterestContext } from '../../composer/public.js';
import type { ReadInterestRollups, ReadTopInterestTopics } from '../../evidence/public.js';
import type { ReadCurrentPlan } from './ports.js';

/**
 * Composer policy v3's view of the person's long-term interest (D-420), over Evidence's index and roll-ups. A read in the caller's
 * transaction: it writes nothing, reasons about nothing and waits on no provider.
 *
 * `leads` is the person's top interest topics (one index range scan of Evidence, so its cost does not depend on how many topics
 * they have met) and the explanation units an unexpired Planner opportunity for existing content names. The plan is read as it is
 * for ranking: stored, accepted, never evidence. `rollups` is the roll-up rows of the given systems and of the person, in the
 * shape of a topic's statistics. Reading only (D-063).
 */
export function makeReadInterestContext(deps: {
  readonly readTop: ReadTopInterestTopics;
  readonly readRollups: ReadInterestRollups;
  readonly readCurrentPlan?: ReadCurrentPlan;
}): ReadInterestContext {
  return {
    async leads(scope, query): Promise<InterestLeads> {
      const topics =
        query.topK > 0 ? await deps.readTop(scope, { limit: query.topK, evaluatedAt: query.evaluatedAt }) : [];
      const plan = await deps.readCurrentPlan?.(scope, { evaluatedAt: query.evaluatedAt });
      const now = Date.parse(query.evaluatedAt);
      const plannedUnitIds = [
        ...new Set(
          (plan?.opportunities ?? [])
            .filter(
              (opportunity) =>
                opportunity.target === 'existing' &&
                // A vertical read is a subject move: an opportunity suited to the related thread only is not for it (as plan lifts are).
                opportunity.eligibility.includes('vertical') &&
                Date.parse(opportunity.expiresAt) > now,
            )
            .map((opportunity) => opportunity.explanationUnitId),
        ),
      ];
      return { topics, plannedUnitIds };
    },
    async rollups(scope, query): Promise<InterestRollups> {
      const rows = await deps.readRollups(scope, {
        systemIds: query.systemIds,
        person: true,
        evaluatedAt: query.evaluatedAt,
      });
      const shape = (row: (typeof rows)[number]) => ({
        activity: row.activity,
        formats: row.formats.map((f) => ({ kind: f.kind, measured: f.measured, qualified: f.qualified })),
      });
      const person = rows.find((row) => row.level === 'person');
      return {
        ...(person ? { person: shape(person) } : {}),
        systems: rows
          .filter((row) => row.level === 'system')
          .map((row) => ({ systemId: row.subjectId, ...shape(row) })),
      };
    },
  };
}
