import type { CutroomPoolIdentity, CutroomPoolReceipt, CutroomScopeTx } from './cutroom-ports.js';
import type {
  CutroomAccountingScopeTx,
  CutroomAccountingTarget,
  WithCutroomAccountingScope,
  CutroomPreparationScopeTx,
} from './cutroom-execution-ports.js';

export interface CutroomSettlementDraft {
  readonly publicationId: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly finalRunId: string;
  readonly actualCents: number;
  readonly financialReport: CutroomFinancialReport;
}
export interface CutroomFinancialReport {
  readonly version: 'cutroom-financial.v1';
  readonly worldId: 'dev' | 'stage';
  readonly businessRunId: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly dispatchId: string;
  readonly poolReceipt: CutroomPoolReceipt;
  readonly runs: readonly {
    readonly runId: string;
    readonly status: 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled';
    readonly ownCostCents: number;
    readonly resultSha256: string;
    readonly recordSha256: string;
  }[];
  readonly finalRunId: string;
  readonly outcome: 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled';
  readonly actualCents: number;
}
export interface CutroomSettlementRecord extends Omit<CutroomSettlementDraft, 'publicationId'> {
  readonly publicationId: string | null;
  readonly operationId: string;
  readonly identity: CutroomPoolIdentity;
  readonly receipt: CutroomPoolReceipt;
  readonly evidenceSha256: string;
  readonly evidenceRef: string;
  readonly state: 'pending' | 'held' | 'confirmed';
  readonly mode: 'hold' | 'settle';
  readonly holdEvidenceId: string | null;
}
declare const settlementPermit: unique symbol;
/** Exact existing liability only. It cannot authorize claim, dispatch, release or a new take. */
export interface CutroomSettlementPermit {
  readonly [settlementPermit]: true;
}
export type CutroomSettlementObservation =
  | { readonly kind: 'held'; readonly code: 'identity' | 'unknown' | 'needs_operator' }
  | { readonly kind: 'confirmed'; readonly evidenceId: string; readonly receipt: CutroomPoolReceipt };
export interface CutroomSettlementPool {
  available(identity: CutroomPoolIdentity): Promise<boolean>;
  settle(permit: CutroomSettlementPermit): Promise<CutroomSettlementObservation>;
}
export interface CutroomSettlementStore {
  create(scope: CutroomScopeTx, attemptId: string, draft: CutroomSettlementDraft): Promise<string | undefined>;
  createHold(
    scope: CutroomAccountingScopeTx,
    snapshotId: string,
    report: CutroomFinancialReport,
  ): Promise<string | undefined>;
  read(scope: CutroomAccountingScopeTx, operationId: string): Promise<CutroomSettlementRecord | undefined>;
  finish(
    scope: CutroomAccountingScopeTx,
    record: CutroomSettlementRecord,
    result: CutroomSettlementObservation,
  ): Promise<void>;
}
export interface CutroomSettlementPorts {
  readonly enabled?: boolean;
  readonly withAccountingScope: WithCutroomAccountingScope;
  readonly store: CutroomSettlementStore;
  readonly pool: CutroomSettlementPool;
}
export interface CutroomSettlement {
  createInScope(scope: CutroomScopeTx, attemptId: string, draft: CutroomSettlementDraft): Promise<string | undefined>;
  recordHold(
    target: CutroomAccountingTarget,
    snapshotId: string,
    report: CutroomFinancialReport,
  ): Promise<string | undefined>;
  process(target: CutroomAccountingTarget, operationId: string): Promise<'disabled' | 'held' | 'confirmed'>;
}
/** Durable delivery bookkeeping, never another paid attempt or work outbox. */
export interface CutroomMaintenance {
  trackInScope(scope: CutroomScopeTx, attemptId: string): Promise<void>;
  begin(target: CutroomAccountingTarget): Promise<string | undefined>;
  end(target: CutroomAccountingTarget, leaseId: string): Promise<void>;
  recover(input: unknown): Promise<{ readonly scanned: number; readonly woken: number }>;
}

/** Read-only proof of NORMAL settlement; never an evidence-only hold or pool operation. */
export interface CutroomConfirmedSettlement {
  readonly operationId: string;
  readonly publicationId: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly financialReport: CutroomFinancialReport;
  readonly financialReportSha256: string;
  readonly receiptUtf8: string;
  readonly receiptSha256: string;
  readonly poolEvidenceId: string;
}
export interface CutroomConfirmedSettlementReader {
  readConfirmed(
    scope: CutroomPreparationScopeTx,
    publicationId: string,
  ): Promise<CutroomConfirmedSettlement | undefined>;
}
