import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeWithPersonalScope } from '../../../infrastructure/postgres/personal-scope.js';
import { fencePersonalRecording } from '../../../infrastructure/postgres/recording-scope.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { makeRecordingPolicy } from '../application/recording-policy.js';
import { FENCE_PERSONAL_RECORDING, RECORDING_POLICY_USE_CASES } from '../public.js';
import { fenceOwnAccount } from './account-access.js';
import { recordingStore } from './recording-store.js';
/** Opt-in prerequisite wiring only. No API route/worker/collection behavior is installed. */
export function recordingPolicyFor(db: Kysely<Database>, options: { lockTimeoutMs: number; now?: () => Date }) {
  return makeRecordingPolicy({
    withScope: makeWithPersonalScope(db, options),
    fenceOwn: fenceOwnAccount,
    store: recordingStore,
    hash: (body) => requestHash('privacy.recording-set', body),
    now: options.now ?? (() => new Date()),
  });
}
export function recordingPolicyProviders(tokens: { useCases: symbol }) {
  return [
    {
      provide: RECORDING_POLICY_USE_CASES,
      inject: [tokens.useCases],
      useFactory: (useCases: ReturnType<typeof recordingPolicyFor>) => useCases,
    },
    { provide: FENCE_PERSONAL_RECORDING, useValue: fencePersonalRecording },
  ];
}
export { recordingStore } from './recording-store.js';
export { makeRecordingPolicy } from '../application/recording-policy.js';
export type { RecordingPorts, RecordingStore } from '../application/recording-ports.js';
