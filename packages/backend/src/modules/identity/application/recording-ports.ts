import type { RecordingPolicy, RecordingPolicyReceipt, SetRecordingPolicy } from '@knowscroll/contracts';
import type { FenceOwnAccount, PersonalScopeTx, WithPersonalScope } from '../public.js';
export interface RecordingSnapshot {
  readonly accountId: string;
  readonly revision: number;
  readonly policy: RecordingPolicy;
}
export interface StoredRecordingCommand {
  readonly universeId: string;
  readonly requestHash: string;
  readonly body: SetRecordingPolicy;
  readonly outcomeVersion: 1;
  readonly receipt: RecordingPolicyReceipt;
}
export interface RecordingStore {
  current(scope: PersonalScopeTx): Promise<RecordingSnapshot | undefined>;
  command(scope: PersonalScopeTx, accountId: string, commandId: string): Promise<StoredRecordingCommand | undefined>;
  /** Atomic policy/revision update followed by immutable receipt insertion in the same scope. */
  accept(scope: PersonalScopeTx, snapshot: RecordingSnapshot, command: StoredRecordingCommand): Promise<void>;
}
export interface RecordingPorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly store: RecordingStore;
  readonly hash: (body: SetRecordingPolicy) => string;
  readonly now: () => Date;
}
