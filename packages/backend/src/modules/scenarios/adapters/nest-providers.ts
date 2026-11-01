import type { Kysely } from 'kysely';
import {
  ENQUEUE_SCROLL_PRODUCTION,
  READ_MADE_TO_ORDER_PRODUCTION,
  READ_ORDER_AUDIENCE,
  READ_SCROLL_EVIDENCE,
  READ_SCROLL_SOURCE_PAGES,
  READ_SHAREABLE_CONTENT,
  type EnqueueScrollProduction,
  type ReadMadeToOrderProduction,
  type ReadOrderAudience,
  type ReadScrollEvidence,
  type ReadScrollSourcePages,
  type ReadShareableContent,
} from '../../content/public.js';
import { READ_VISITED_ASSETS, type ReadVisitedAssets } from '../../experience/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import {
  ANNOUNCE_THREAD,
  READ_THREAD_STANDING,
  THREAD_GUEST,
  type AnnounceThread,
  type ReadThreadStanding,
  type ThreadGuest,
} from '../../social/public.js';
import { COMMISSION_SCENARIO_ORDER, type CommissionScenarioOrder } from '../../supply/public.js';
import {
  CHECK_SCENARIOS_RECORDING_RUN,
  type CheckPersonalRecordingRun,
  type RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import { stableUuid } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import { makeReadOrderAudience } from '../application/audience.js';
import { makeCheckScenariosRecordingRun } from '../application/check-recording-run.js';
import { makeChoose } from '../application/choose.js';
import { makeListScenarios } from '../application/list.js';
import type { AnswerWorkerPorts, DraftWorkerPorts, ScenarioPorts } from '../application/ports.js';
import { makeReadDraft } from '../application/read-draft.js';
import { makeRemoveScenario } from '../application/remove.js';
import { makeResolveBranches } from '../application/resolve.js';
import { makeStartDraft } from '../application/start-draft.js';
import { makeSuggestDraft } from '../application/suggest.js';
import { makeWriteAnswer } from '../application/write-answer.js';
import { suggestDraftQueue, writeAnswerQueue } from '../events.js';
import {
  RESOLVE_SCENARIO_BRANCHES,
  SCENARIO_USE_CASES,
  SUGGEST_SCENARIO_DRAFT,
  WRITE_SCENARIO_ANSWER,
  type ScenarioUseCases,
} from '../public.js';
import { branchPoolStore, scenarioStore } from './postgres-store.js';

/** The tokens of the process that composes these providers. */
export interface ScenarioTokens {
  readonly withPersonalScope: symbol;
  readonly database: symbol;
}

const SCENARIO_WORKER_PORTS = Symbol('scenarios.workerPorts');

/** The ports both processes share: the thread, the store and the thread-root metadata. */
const workerPortsProvider = (tokens: ScenarioTokens) => ({
  provide: SCENARIO_WORKER_PORTS,
  inject: [tokens.withPersonalScope, THREAD_GUEST, READ_SHAREABLE_CONTENT, READ_THREAD_STANDING],
  useFactory: (
    withScope: WithPersonalScope,
    guest: ThreadGuest,
    readContent: ReadShareableContent,
    standing: ReadThreadStanding,
  ): DraftWorkerPorts => ({
    withScope,
    guest,
    store: scenarioStore,
    readContent,
    standing,
    now: () => new Date(),
  }),
});

/**
 * The API's scenarios: the use cases behind the HTTP routes, and the audience that decides who may
 * open the Scroll of a branch (`READ_ORDER_AUDIENCE`, which content asks). Needs Social's thread
 * guest and standing, content's reads and Quartermaster's scenario Create (supply) in the same root.
 */
export function scenarioProviders(tokens: ScenarioTokens & { readonly enqueueJob: symbol }) {
  return [
    workerPortsProvider(tokens),
    {
      provide: SCENARIO_USE_CASES,
      inject: [
        SCENARIO_WORKER_PORTS,
        tokens.enqueueJob,
        READ_SCROLL_SOURCE_PAGES,
        COMMISSION_SCENARIO_ORDER,
        READ_VISITED_ASSETS,
      ],
      useFactory: (
        base: DraftWorkerPorts,
        enqueue: EnqueueJob,
        readSourcePages: ReadScrollSourcePages,
        commission: CommissionScenarioOrder,
        readVisited: ReadVisitedAssets,
      ): ScenarioUseCases => {
        const ports: ScenarioPorts = {
          ...base,
          readSourcePages,
          commission,
          readVisited,
          enqueueSuggest: (scope, job) =>
            enqueue(
              scope,
              suggestDraftQueue,
              {
                v: 1,
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
                draftId: job.draftId,
              },
              { jobId: stableUuid(`scenario-suggest:${job.draftId}`), duplicate: 'ignore' },
            ),
          enqueueAnswer: (scope, job) =>
            enqueue(
              scope,
              writeAnswerQueue,
              {
                v: 1,
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
                nodeId: job.nodeId,
              },
              { jobId: stableUuid(`scenario-answer:${job.nodeId}`), duplicate: 'ignore' },
            ),
          hash: (operation, input) => requestHash(operation, input as CanonicalJson),
          stableId: (...parts) => stableUuid(parts.join(':')),
        };
        return {
          draft: makeStartDraft(ports),
          readDraft: makeReadDraft(ports),
          choose: makeChoose(ports),
          list: makeListScenarios(ports),
          remove: makeRemoveScenario(ports),
        };
      },
    },
    ...orderAudienceProviders(tokens),
  ];
}

/**
 * Who may reach the Scroll of a branch (`READ_ORDER_AUDIENCE`, which Content asks): the members of its
 * thread now. Both processes that serve a person's reads compose it: the API for every way in by ID,
 * and the worker for the data export, which must not list a title the person can no longer read.
 * Needs Social's `READ_THREAD_STANDING`.
 */
export function orderAudienceProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: READ_ORDER_AUDIENCE,
      inject: [tokens.database, READ_THREAD_STANDING],
      useFactory: (db: Kysely<Database>, standing: ReadThreadStanding): ReadOrderAudience =>
        makeReadOrderAudience(branchPoolStore(db), standing),
    },
  ];
}

/**
 * The owner check the recording-aware harness runs for Scenarios' personal runs (D-270): the draft or branch a run serves must
 * still be waiting for it. Installed wherever the recording harness is (the worker), because the harness cannot be built without it.
 */
export function scenariosRecordingOwnerProviders() {
  return [
    {
      provide: CHECK_SCENARIOS_RECORDING_RUN,
      inject: [],
      useFactory: (): CheckPersonalRecordingRun => makeCheckScenariosRecordingRun({ store: scenarioStore }),
    },
  ];
}

/**
 * The worker's scenarios: the planner step that answers a draft and the step that writes a what-if's short answer
 * (both run on the recording-aware personal harness, at the person's recording generation, D-270), and the sweep that
 * settles preparing branches and ends a short answer's wait (it needs the process's pg-boss to send a production job outside
 * a transaction).
 */
export function scenarioWorkerProviders(tokens: ScenarioTokens & { readonly harness: symbol }) {
  return [
    workerPortsProvider(tokens),
    {
      provide: WRITE_SCENARIO_ANSWER,
      inject: [SCENARIO_WORKER_PORTS, READ_SCROLL_EVIDENCE, ANNOUNCE_THREAD, tokens.harness],
      useFactory: (
        base: DraftWorkerPorts,
        readEvidence: ReadScrollEvidence,
        announce: AnnounceThread,
        harness: RecordingReasoningHarness,
      ) => {
        const ports: AnswerWorkerPorts = { ...base, readEvidence, announce };
        return makeWriteAnswer(ports, harness);
      },
    },
    {
      provide: SUGGEST_SCENARIO_DRAFT,
      inject: [SCENARIO_WORKER_PORTS, tokens.harness],
      useFactory: (ports: DraftWorkerPorts, harness: RecordingReasoningHarness) => makeSuggestDraft(ports, harness),
    },
    {
      provide: RESOLVE_SCENARIO_BRANCHES,
      inject: [tokens.database, READ_MADE_TO_ORDER_PRODUCTION, ENQUEUE_SCROLL_PRODUCTION, ANNOUNCE_THREAD],
      useFactory: (
        db: Kysely<Database>,
        readProduction: ReadMadeToOrderProduction,
        sendProduction: EnqueueScrollProduction,
        announce: AnnounceThread,
      ) =>
        makeResolveBranches({
          store: branchPoolStore(db),
          readProduction,
          // A person is waiting on a branch: ahead of operator seeding, as Create sends it.
          sendProduction: async (recipe, take) => {
            await sendProduction(recipe, take, 10);
          },
          announce,
          now: () => new Date(),
        }),
    },
  ];
}
