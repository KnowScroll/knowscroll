import type { CreateContentRequest } from '@knowscroll/contracts';
import type { ReadLibraryPassages } from '../../content/public.js';
import { applyClosingRun, proposeWhenRecording, runToClose } from '../../../reasoning/public.js';
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
import { checkLibraryMatch } from './ask-library.js';
import type { LibraryVerdict } from './ask-library-role.js';
import { commissionAskOrder } from './ask-orders.js';
import { commissionSupply, nextPoll } from './commission.js';
import { catalogueBrief, checkedRevision, inventory, sameRef, snapshot } from './inventory.js';
import type { CanonicalBrief, Demand, SupplyPorts } from './ports.js';
import {
  accountOf,
  closeStartedRunAlone,
  proposeAtGeneration,
  type RecordingRuns,
  type RunOwner,
  type StartedRun,
} from './recording-runs.js';
import { startRunOwner } from '../../../reasoning/public.js';

/**
 * Places one waiting request: matches a free-text ask to the catalogue, or decides where a question asked from a
 * Scroll belongs. The resolver calls it for a `matching` request.
 */
export type MatchStep = (job: ResolveSupplyJob, signal: AbortSignal) => Promise<void>;

const formatOf = (command: CreateContentRequest): 'reel' | 'scroll' | 'either' =>
  command.intent.kind === 'topic' ? command.intent.format : 'scroll';

type Authority = Parameters<SupplyPorts['withScope']>[0];

/** What a waiting request needs a model to place: free text to match, or a question with the place it was asked from. */
type Asked =
  /** `owner` is absent while recording is paused: the match is then refused without a run (D-270). */
  | { readonly kind: 'text'; readonly text: string; readonly owner: RunOwner | undefined }
  /** `owner` names the account and the recording generation the question was asked at (D-264). */
  | { readonly kind: 'ask'; readonly facts: AskScopeFacts; readonly owner: RunOwner }
  /** The Scroll the question was asked from can no longer be read: there is nothing to place it by. */
  | { readonly kind: 'source_gone' };

/** The fields a verdict changes on the request. */
type Decided = Pick<
  Demand,
  'status' | 'decision' | 'reason' | 'brief' | 'workId' | 'askOrder' | 'content' | 'contentAvailabilityRevision'
>;

/** Reads what the request needs placed, inside the caller's transaction; nothing when it is no longer waiting. */
async function askedOf(
  p: SupplyPorts,
  recording: RecordingRuns,
  scope: PersonalScopeTx,
  d: Demand | undefined,
): Promise<Asked | undefined> {
  if (d?.status !== 'matching') return undefined;
  const { intent } = d.command;
  if (intent.kind === 'ask') {
    const facts = await p.readAskFacts(scope, intent.source, intent.anchor.stopId);
    if (facts === undefined) return { kind: 'source_gone' };
    const accountId = await accountOf(recording.fenceOwn, scope);
    if (accountId === undefined) return undefined;
    return {
      kind: 'ask',
      facts: { question: intent.question, title: facts.title, stopText: facts.stopText },
      owner: {
        accountId,
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        recordId: d.id,
        recordingGeneration: intent.recordingGeneration,
      },
    };
  }
  if (intent.kind !== 'topic' || intent.subject.kind !== 'text') return undefined;
  return { kind: 'text', text: intent.subject.text, owner: await startRunOwner(recording.harness, scope, d.id) };
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
 * every transaction. Steps: (1) one transaction reads the still-waiting ask; (2) outside any
 * transaction the harness makes one model call (plus at most one repair) on the request's own run;
 * (3) one transaction rechecks the ask is still waiting (a cancel wins), applies the verdict, and
 * closes the run. The person's words go to the provider only through the personal harness, whose
 * protected request bytes are erased with the person.
 * Both run on the recording-aware harness (D-264, D-270). A question asked from a Scroll runs at the recording generation it was
 * asked at. A free-text ask carries none, so it runs at the generation recording is at when this step starts, and is refused
 * without a model call while recording is paused. A person who paused and resumed gets answers, and a verdict reached before
 * a pause or a Clear is not applied.
 * Failure/retry: the run ID is the request ID, so a redelivery answers from the ledger and never pays
 * twice, and an attempt of unknown outcome is never resent: the request closes as `could_not_prepare`
 * and the run stays open for an operator.
 */
export function makeMatchRequest(
  p: SupplyPorts,
  recording: RecordingRuns,
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
      return askedOf(p, recording, scope, await p.store.read(scope, job.requestId));
    });
    if (read.kind !== 'entered' || read.value === undefined) return;
    const asked = read.value;
    const deps = { p, recording, readLibrary };
    if (asked.kind === 'text') await matchText(deps, authority, job, asked, signal);
    else await placeQuestion(deps, authority, job, asked, signal);
  };
}

/**
 * The one model call (and its one repair) that matches free text to the catalogue, outside every transaction. The verdict is
 * applied under the recording fence, as a question's is.
 */
async function matchText(
  deps: QuestionDeps,
  authority: Authority,
  job: ResolveSupplyJob,
  asked: Extract<Asked, { readonly kind: 'text' }>,
  signal: AbortSignal,
): Promise<void> {
  const { outcome, purpose } = await proposeWhenRecording(
    deps.recording.harness,
    asked.owner,
    {
      run: {
        id: job.requestId,
        authority,
        ownerModule: 'supply',
        purpose: 'match-request',
        policyVersion: MATCH_POLICY_VERSION,
      },
      role: MATCH_ROLE,
      context: matchContext(job.requestId, asked.text),
      limits: { allowRepair: true },
    },
    signal,
  );
  const verdict = matchVerdict(outcome);
  await applyQuestionVerdict(
    deps,
    authority,
    job.requestId,
    runToClose(job.requestId, purpose, verdict.end),
    verdict,
    undefined,
  );
}

/** What placing a question needs: the ports, the recording-aware harness and the shared read of a library Scroll's prose. */
interface QuestionDeps {
  readonly p: SupplyPorts;
  readonly recording: RecordingRuns;
  readonly readLibrary: ReadLibraryPassages;
}

/**
 * Places a question asked from a Scroll: the scope step, then, for a question placed on another subject, the library check.
 * Both are model calls outside every transaction, stamped with the generation the question was asked at. The verdict is
 * applied under that generation's fence, or the question closes as `could_not_prepare` and the verdict is dropped.
 */
async function placeQuestion(
  deps: QuestionDeps,
  authority: Authority,
  job: ResolveSupplyJob,
  asked: Extract<Asked, { readonly kind: 'ask' | 'source_gone' }>,
  signal: AbortSignal,
): Promise<void> {
  const { p, recording, readLibrary } = deps;
  if (asked.kind === 'source_gone') return closeUnplaced(p, authority, job.requestId, 'source_unavailable');
  const { outcome, purpose } = await proposeAtGeneration(
    recording.harness,
    asked.owner,
    {
      run: {
        id: job.requestId,
        authority,
        ownerModule: 'supply',
        purpose: 'ask-scope',
        policyVersion: ASK_SCOPE_POLICY_VERSION,
      },
      role: ASK_SCOPE_ROLE,
      context: askScopeContext(job.requestId, asked.facts),
      limits: { allowRepair: true },
    },
    signal,
  );
  const verdict = askScopeVerdict(outcome);
  const scopeRun = runToClose(job.requestId, purpose, verdict.end);
  // A question placed on another subject is read against that subject's library Scrolls (a second call, outside every transaction).
  const library =
    verdict.kind === 'matched'
      ? await checkLibraryMatch(
          { p, harness: recording.harness, readLibrary },
          authority,
          { requestId: job.requestId, question: asked.facts.question, match: verdict.match, owner: asked.owner },
          signal,
        )
      : undefined;
  // A transaction closes one personal run, so the library check's run closes first, in a transaction of its own. If the process
  // dies after it, a redelivery finds that run closed and offers no library Scroll (an order is made instead); the scope step's
  // run is closed with its verdict applied, so its answer is never lost.
  if (library?.run !== undefined) await closeStartedRunAlone(recording.harness, authority, library.run);
  await applyQuestionVerdict(deps, authority, job.requestId, scopeRun, verdict, library?.verdict);
}

/**
 * Applies the scope step's (or the free-text match's) verdict and closes its run in one transaction under the recording
 * fence. When the fence no longer holds (the person paused, resumed or cleared, or the request is no longer waiting) nothing
 * of the verdict is applied and the request closes as `could_not_prepare`, which writes only the end of the request that was
 * asked. A verdict with no run to close is a failure to place, which needs no fence.
 */
async function applyQuestionVerdict(
  deps: QuestionDeps,
  authority: Authority,
  requestId: string,
  scopeRun: StartedRun | undefined,
  verdict: AskScopeVerdict,
  library: LibraryVerdict | undefined,
): Promise<void> {
  const { p, recording } = deps;
  if (scopeRun !== undefined) {
    const applied = await applyClosingRun(recording.harness, authority, scopeRun, (scope) =>
      applyVerdict(p, scope, requestId, verdict, library),
    );
    if (applied.kind === 'applied') return;
    return closeUnplaced(p, authority, requestId, 'could_not_prepare');
  }
  await p.withScope(authority, async (scope) => {
    if (await p.ownerActive(scope)) await applyVerdict(p, scope, requestId, verdict, library);
  });
}

/** Closes a waiting request that could not be placed, in a transaction of its own. */
async function closeUnplaced(
  p: SupplyPorts,
  authority: Authority,
  requestId: string,
  reason: 'source_unavailable' | 'could_not_prepare',
): Promise<void> {
  await p.withScope(authority, async (scope) => {
    if (await p.ownerActive(scope)) await applyVerdict(p, scope, requestId, { kind: 'unavailable', reason }, undefined);
  });
}

/** Applies a verdict to the request if it still waits, inside the caller's transaction (a cancel that came meanwhile wins). */
async function applyVerdict(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  requestId: string,
  verdict: AskScopeVerdict,
  library: LibraryVerdict | undefined,
): Promise<void> {
  const d = await p.store.read(scope, requestId);
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
}
