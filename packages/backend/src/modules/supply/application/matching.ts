import type { CreateContentRequest } from '@knowscroll/contracts';
import type { ReadLibraryPassages } from '../../content/public.js';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { MATCH_POLICY_VERSION, MATCH_ROLE, matchContext, matchVerdict } from './match-role.js';
import {
  ASK_SCOPE_POLICY_VERSION,
  ASK_SCOPE_ROLE,
  askScopeContext,
  askScopeVerdict,
  type AskScopeFacts,
  type AskScopeVerdict,
} from './ask-scope.js';
import type { ResolveSupplyJob } from '../events.js';
import { askLibraryRunId, checkLibraryMatch } from './ask-library.js';
import type { LibraryVerdict } from './ask-library-role.js';
import { commissionAskOrder } from './ask-orders.js';
import { commissionSupply, nextPoll } from './commission.js';
import { catalogueBrief, checkedRevision, inventory, sameRef, snapshot } from './inventory.js';
import type { CanonicalBrief, Demand, SupplyPorts } from './ports.js';

/**
 * Places one waiting request: matches a free-text ask to the catalogue, or decides where a question asked from a
 * Scroll belongs. The resolver calls it for a `matching` request.
 */
export type MatchStep = (job: ResolveSupplyJob, signal: AbortSignal) => Promise<void>;

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

const formatOf = (command: CreateContentRequest): 'reel' | 'scroll' | 'either' =>
  command.intent.kind === 'topic' ? command.intent.format : 'scroll';

/** What a waiting request needs a model to place: free text to match, or a question with the place it was asked from. */
type Asked =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ask'; readonly facts: AskScopeFacts }
  /** The Scroll the question was asked from can no longer be read: there is nothing to place it by. */
  | { readonly kind: 'source_gone' };

/** The fields a verdict changes on the request. */
type Decided = Pick<
  Demand,
  'status' | 'decision' | 'reason' | 'brief' | 'workId' | 'askOrder' | 'content' | 'contentAvailabilityRevision'
>;

/** Reads what the request needs placed, inside the caller's transaction; nothing when it is no longer waiting. */
async function askedOf(p: SupplyPorts, scope: PersonalScopeTx, d: Demand | undefined): Promise<Asked | undefined> {
  if (d?.status !== 'matching') return undefined;
  const { intent } = d.command;
  if (intent.kind === 'ask') {
    const facts = await p.readAskFacts(scope, intent.source, intent.anchor.stopId);
    return facts === undefined
      ? { kind: 'source_gone' }
      : { kind: 'ask', facts: { question: intent.question, title: facts.title, stopText: facts.stopText } };
  }
  return intent.kind === 'topic' && intent.subject.kind === 'text'
    ? { kind: 'text', text: intent.subject.text }
    : undefined;
}

/**
 * A question the scope step placed with the Scroll being read: an ask order is made for it. The Scroll and its stop
 * are read again here, under the lock, so a Scroll that was withdrawn meanwhile closes the ask instead of being
 * written about.
 */
async function decideHere(p: SupplyPorts, scope: PersonalScopeTx, d: Demand): Promise<Decided> {
  const { intent } = d.command;
  const facts = intent.kind === 'ask' ? await p.readAskFacts(scope, intent.source, intent.anchor.stopId) : undefined;
  if (intent.kind !== 'ask' || facts === undefined)
    return { status: 'unavailable', decision: 'refuse', reason: 'source_unavailable' };
  const commissioned = await commissionAskOrder(p, scope, { source: intent.source, facts, question: intent.question });
  return commissioned.kind === 'commissioned'
    ? { status: 'requested', decision: 'create', reason: undefined, askOrder: commissioned.order }
    : { status: 'unavailable', decision: 'refuse', reason: commissioned.reason };
}

/**
 * A question asked from a Scroll that the scope step placed on another catalogue subject (D-251). A library Scroll of that
 * subject is offered only when the checker found that it answers the question and the Scroll is still admitted when the
 * verdict is applied. Otherwise an order is made for the question, within the caps, or the request closes honestly. The
 * library is never started for a question: a Scroll made for the subject is not known to answer it.
 */
async function decideAskedLibrary(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  d: Demand,
  brief: CanonicalBrief,
  library: LibraryVerdict,
): Promise<Decided> {
  if (library.kind === 'unavailable') return { status: 'unavailable', decision: 'refuse', reason: library.reason };
  if (library.kind === 'pick') {
    const offered = (await inventory(p, scope, d.command, brief)).servable.find((head) =>
      sameRef(head.ref, library.ref),
    );
    if (offered?.encounter)
      return {
        status: 'ready',
        decision: 'reuse',
        reason: undefined,
        brief,
        content: offered.encounter,
        contentAvailabilityRevision: offered.availabilityRevision,
      };
  }
  return decideHere(p, scope, d);
}

/**
 * What the verdict does to the request: the fields it changes, decided before the revision advances.
 * A matched free-text ask is then handled as a person's own catalogue ask would have been: Reuse, else Join or Create.
 * A matched question asked from a Scroll is answered by a library Scroll only if the checker found one that answers it,
 * and otherwise by an order (`decideAskedLibrary`). It never binds to the explanation it was asked from: `inventory`
 * skips it, as it does for the poll and for Try again.
 */
async function decide(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  d: Demand,
  verdict: AskScopeVerdict,
  library: LibraryVerdict | undefined,
): Promise<Decided> {
  const closed = (reason: NonNullable<Demand['reason']>) =>
    ({ status: 'unavailable', decision: 'refuse', reason }) as const;
  if (verdict.kind === 'no_topic') return closed('unsupported_request');
  if (verdict.kind === 'unavailable') return closed(verdict.reason);
  if (verdict.kind === 'here') return decideHere(p, scope, d);
  const brief = catalogueBrief(d.command, verdict.match, formatOf(d.command));
  if (d.command.intent.kind === 'ask') return decideAskedLibrary(p, scope, d, brief, library ?? { kind: 'none' });
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
 * Free-text asks (E04) and questions asked from a Scroll (D1): a model proposes where the words belong, and code
 * accepts only what the schema allows (an exact catalogue member, or the Scroll being read), so the model never
 * invents a topic and never admits content. For a question asked from a Scroll the answer may be "here", and code
 * then makes an ask order. No place closes the request honestly as unsupported.
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
export function makeMatchRequest(
  p: SupplyPorts,
  harness: ReasoningHarness,
  readLibrary: ReadLibraryPassages,
): MatchStep {
  return async (job, signal) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'supply.match' },
    } as const;
    const read = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      return askedOf(p, scope, await p.store.read(scope, job.requestId));
    });
    if (read.kind !== 'entered' || read.value === undefined) return;
    const verdict = await place(harness, authority, job, read.value, signal);
    // A question placed on another subject is read against that subject's library Scrolls (a second call, outside every transaction).
    const library =
      read.value.kind === 'ask' && verdict.kind === 'matched'
        ? await checkLibraryMatch(
            { p, harness, readLibrary },
            authority,
            { requestId: job.requestId, question: read.value.facts.question, match: verdict.match },
            signal,
          )
        : undefined;

    // A transaction closes one personal run, so the library check's run closes first, in a transaction of its own. If the
    // process dies after it, a redelivery finds that run closed and offers no library Scroll (an order is made instead);
    // the scope step's run is closed with its verdict applied, so its answer is never lost.
    if (library?.end !== undefined)
      await p.withScope(authority, (scope) => closeRun(harness, scope, askLibraryRunId(p, job.requestId), library.end));
    await p.withScope(authority, async (scope) => {
      await closeRun(harness, scope, job.requestId, verdict.end);
      if (!(await p.ownerActive(scope))) return;
      const d = await p.store.read(scope, job.requestId);
      if (!d || d.status !== 'matching') return;
      const decided = await decide(p, scope, d, verdict, library);
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
      if (next.status === 'requested') await p.enqueue(scope, d.id, nextPoll(d, p.now()));
      await p.notify(scope, revision, d.id);
    });
  };
}

/** The one model call (and its one repair) that places the request, outside every transaction. */
async function place(
  harness: ReasoningHarness,
  authority: Parameters<ReasoningHarness['propose']>[0]['run']['authority'],
  job: ResolveSupplyJob,
  asked: Asked,
  signal: AbortSignal,
): Promise<AskScopeVerdict> {
  if (asked.kind === 'source_gone') return { kind: 'unavailable', reason: 'source_unavailable' };
  const ask = asked.kind === 'ask';
  const run = {
    id: job.requestId,
    authority,
    ownerModule: 'supply',
    purpose: ask ? 'ask-scope' : 'match-request',
    policyVersion: ask ? ASK_SCOPE_POLICY_VERSION : MATCH_POLICY_VERSION,
  } as const;
  const limits = { allowRepair: true };
  if (asked.kind === 'ask') {
    const outcome = await harness.propose(
      { run, role: ASK_SCOPE_ROLE, context: askScopeContext(job.requestId, asked.facts), limits },
      signal,
    );
    return askScopeVerdict(outcome);
  }
  const outcome = await harness.propose(
    { run, role: MATCH_ROLE, context: matchContext(job.requestId, asked.text), limits },
    signal,
  );
  return matchVerdict(outcome);
}

/** Closes a model run in the transaction that applies its verdict; a run the harness already refused to close stays as it was. */
async function closeRun(
  harness: ReasoningHarness,
  scope: PersonalScopeTx,
  runId: string,
  end: 'completed' | 'failed' | 'cancelled' | undefined,
): Promise<void> {
  if (end === undefined) return;
  try {
    await harness.closeRun(scope, { runId, state: end });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
  }
}
