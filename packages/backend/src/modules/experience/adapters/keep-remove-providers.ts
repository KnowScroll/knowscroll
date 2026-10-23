import { requireRecordingEffects } from './recording-store.js';
import {
  FENCE_OWN_ACCOUNT,
  READ_RECORDING_LIFECYCLE,
  type ReadRecordingLifecycle,
  type FenceOwnAccount,
  type WithPersonalScope,
} from '../../identity/public.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import { makeRemoveKeepEntry, type KeepRemovalPorts } from '../application/keep-remove.js';
import { KEEP_REMOVAL_USE_CASE, type KeepRemovalUseCase, type ExperienceRecordingEffects } from '../public.js';
import { makeCommitAction, readChannels } from './action-store.js';
import { keepStore } from './keep-store.js';

/** Existing Unsave effects and queues, under the new exact-membership command's single scope. */
export function keepRemovalUseCase(
  deps: Pick<KeepRemovalPorts, 'withScope' | 'fenceOwn'> & {
    readonly enqueue: EnqueueJob;
    readonly lifecycle: ReadRecordingLifecycle;
    readonly recordingEffects?: ExperienceRecordingEffects;
  } & Partial<
      Pick<
        KeepRemovalPorts,
        'membership' | 'findReceipt' | 'beginReceipt' | 'completeReceipt' | 'advance' | 'notify' | 'now' | 'newId'
      >
    >,
): KeepRemovalUseCase {
  return makeRemoveKeepEntry({
    ...deps,
    membership: deps.membership ?? ((scope, assetId) => keepStore.membership(scope, assetId)),
    findReceipt: deps.findReceipt ?? findPersonalReceipt,
    beginReceipt: deps.beginReceipt ?? insertPersonalReceipt,
    completeReceipt: deps.completeReceipt ?? completePersonalReceipt,
    readChannels,
    commitAction: makeCommitAction(deps.enqueue, deps.lifecycle, deps.recordingEffects),
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
    advance: deps.advance ?? advanceScopeRevision,
    notify: deps.notify ?? notifyScopeChanged,
    now: deps.now ?? (() => new Date()),
    newId: deps.newId ?? (() => uuidv7()),
  });
}
export function keepRemovalProviders(
  tokens: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol },
  options: { readonly recordingEffects?: symbol } = {},
) {
  return [
    {
      provide: KEEP_REMOVAL_USE_CASE,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_RECORDING_LIFECYCLE,
        tokens.enqueueJob,
        ...(options.recordingEffects ? [options.recordingEffects] : []),
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        lifecycle: ReadRecordingLifecycle,
        enqueue: EnqueueJob,
        effects?: ExperienceRecordingEffects,
      ) =>
        keepRemovalUseCase({
          withScope,
          fenceOwn,
          enqueue,
          lifecycle,
          ...(options.recordingEffects ? { recordingEffects: requireRecordingEffects(effects) } : {}),
        }),
    },
  ];
}
export type { KeepRemovalPorts } from '../application/keep-remove.js';
