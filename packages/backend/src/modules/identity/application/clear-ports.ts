import type {
  ClearExplorationAcceptance,
  ClearExplorationStatus,
  ClearExplorationStatusTarget,
} from '@knowscroll/contracts';
import type {
  ClearAccountingTx,
  ClearBinding,
  ClearCoreTx,
  ClearLiability,
  PrivacyScopeTx,
  WithClearMaintenance,
  WithPrivacyScope,
} from '../public.js';
import type { ClearReasoning } from '../../../reasoning/public.js';
import type { ClearExplorationJob } from '../events.js';
export interface ClearOperation extends ClearBinding {
  readonly requestHash: string;
  readonly outcomeVersion: number;
  readonly recordedAt: string;
  readonly coreDone: boolean;
  readonly completed: boolean;
  readonly phase: 'removing_live_data' | 'waiting_for_accounting' | 'verifying_live_removal';
  readonly failureCode: 'temporarily_unavailable' | 'completion_unverified' | null;
}
export interface ClearStore {
  read(scope: PrivacyScopeTx, target: ClearExplorationStatusTarget): Promise<ClearOperation | undefined>;
  create(
    scope: PrivacyScopeTx,
    commandId: string,
    hash: string,
    liabilities: readonly ClearLiability[],
  ): Promise<ClearOperation>;
  coreDone(scope: ClearCoreTx): Promise<void>;
  accountingDone(
    scope: ClearAccountingTx,
    result: 'pending' | 'verified' | 'verified_retained',
  ): Promise<Date | undefined>;
  cleanupDone(scope: ClearAccountingTx): Promise<void>;
  claimRecovery(scope: ClearCoreTx | ClearAccountingTx): Promise<boolean>;
  fail(
    scope: ClearCoreTx | ClearAccountingTx,
    code: 'temporarily_unavailable' | 'completion_unverified',
  ): Promise<void>;
}
export interface ClearPorts {
  readonly withPrivacyScope: WithPrivacyScope;
  readonly withMaintenance: WithClearMaintenance;
  readonly withRecoveryMaintenance: WithClearMaintenance;
  readonly readRecoveryCandidates: () => Promise<readonly { readonly accountId: string; readonly commandId: string }[]>;
  readonly store: ClearStore;
  readonly reasoning: ClearReasoning;
  readonly hash: (input: unknown) => string;
  readonly eraseCore: (scope: ClearCoreTx) => Promise<void>;
  readonly isCore: (scope: ClearCoreTx | ClearAccountingTx) => scope is ClearCoreTx;
  readonly enqueue: (
    scope: PrivacyScopeTx | ClearCoreTx | ClearAccountingTx,
    job: ClearExplorationJob,
    startAfter?: Date,
  ) => Promise<void>;
  readonly now: () => Date;
}
export type ClearRejected = {
  readonly kind: 'rejected';
  readonly code: 'INVALID_REQUEST' | 'CONFLICT' | 'COMMAND_KEY_REUSED' | 'SERVICE_UNAVAILABLE';
};
export type ClearAccepted = { readonly kind: 'ok'; readonly value: ClearExplorationAcceptance };
export type ClearStatusRead = { readonly kind: 'ok'; readonly value: ClearExplorationStatus };
