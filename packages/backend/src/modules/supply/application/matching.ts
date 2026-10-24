import type { CreateContentRequest } from '@knowscroll/contracts';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { MATCH_POLICY_VERSION, MATCH_ROLE, matchContext, matchVerdict, type MatchVerdict } from './match-role.js';
import type { ResolveSupplyJob } from '../events.js';
import { commissionSupply, nextPoll } from './commission.js';
import { catalogueBrief, checkedRevision, inventory, snapshot } from './inventory.js';
import type { Demand, SupplyPorts } from './ports.js';

/** Matches one waiting free-text ask to the catalogue; the resolver calls it for a `matching` request. */
export type MatchStep = (job: ResolveSupplyJob, signal: AbortSignal) => Promise<void>;

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

const textOf = (command: CreateContentRequest): string | undefined =>
  command.intent.kind === 'topic' && command.intent.subject.kind === 'text' ? command.intent.subject.text : undefined;
const formatOf = (command: CreateContentRequest): 'reel' | 'scroll' | 'either' =>
  command.intent.kind === 'topic' ? command.intent.format : 'either';

/**
 * What the verdict does to the request: the fields it changes, decided before the revision advances.
 * A matched ask is then handled as a person's own catalogue ask would have been: Reuse, else Join or Create.
 */
async function decide(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  d: Demand,
  verdict: MatchVerdict,
): Promise<
  Pick<Demand, 'status' | 'decision' | 'reason' | 'brief' | 'workId' | 'content' | 'contentAvailabilityRevision'>
> {
  const closed = (reason: NonNullable<Demand['reason']>) =>
    ({ status: 'unavailable', decision: 'refuse', reason }) as const;
  if (verdict.kind === 'no_topic') return closed('unsupported_request');
  if (verdict.kind === 'unavailable') return closed(verdict.reason);
  const brief = catalogueBrief(d.command, verdict.match, formatOf(d.command));
  const found = (await inventory(p, scope, d.command, brief)).ready;
  if (found?.encounter)
    return {
      status: 'ready',
      decision: 'reuse',
      reason: undefined,
      brief,
      content: found.encounter,
      contentAvailabilityRevision: found.availabilityRevision,
    };
  const commissioned = await commissionSupply(p, scope, brief, 'person');
  return commissioned.kind === 'waiting'
    ? { status: 'requested', decision: commissioned.decision, reason: undefined, brief, workId: commissioned.workId }
    : { ...closed(commissioned.reason), brief };
}

/**
 * Free-text asks (E04): a model proposes which catalogue topic and facet the words are about, and
 * code accepts only an exact catalogue member (the answer schema refuses anything else), so the model
 * never invents a topic and never admits content. No match closes the request honestly as unsupported.
 *
 * Authority: a `system` actor for the job's universe and epoch, rechecked under the personal lock in
 * both transactions. Steps: (1) one transaction reads the still-waiting ask; (2) outside any
 * transaction the harness makes one model call (plus at most one repair) on the request's own run;
 * (3) one transaction rechecks the ask is still waiting (a cancel wins), applies the verdict, and
 * closes the run. The person's words go to the provider only through the personal harness, whose
 * protected request bytes are erased with the person.
 * Failure/retry: the run ID is the request ID, so a redelivery answers from the ledger and never pays
 * twice, and an attempt of unknown outcome is never resent: the request closes as `could_not_prepare`
 * and the run stays open for an operator.
 */
export function makeMatchRequest(p: SupplyPorts, harness: ReasoningHarness): MatchStep {
  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'supply.match' },
    } as const;
    const asked = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      const d = await p.store.read(scope, job.requestId);
      return d?.status === 'matching' ? textOf(d.command) : undefined;
    });
    if (asked.kind !== 'entered' || asked.value === undefined) return;

    const outcome = await harness.propose(
      {
        run: {
          id: job.requestId,
          authority,
          ownerModule: 'supply',
          purpose: 'match-request',
          policyVersion: MATCH_POLICY_VERSION,
        },
        role: MATCH_ROLE,
        context: matchContext(job.requestId, asked.value),
        limits: { allowRepair: true },
      },
      signal,
    );
    const verdict = matchVerdict(outcome);

    await p.withScope(authority, async (scope) => {
      if (verdict.end) {
        try {
          await harness.closeRun(scope, { runId: job.requestId, state: verdict.end });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
        }
      }
      if (!(await p.ownerActive(scope))) return;
      const d = await p.store.read(scope, job.requestId);
      if (!d || d.status !== 'matching') return;
      const decided = await decide(p, scope, d, verdict);
      const current = await snapshot(p, scope, d);
      const revision = await p.advance(scope);
      const next: Demand = {
        ...d,
        ...decided,
        revision,
        requestRevision: checkedRevision(current.requestRevision + 1),
        updatedAt: p.now().toISOString(),
      };
      await p.store.finish(scope, next);
      if (next.status === 'requested') await p.enqueue(scope, d.id, nextPoll(d.createdAt, p.now()));
      await p.notify(scope, revision, d.id);
    });
  };
}
