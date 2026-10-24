import type { FindAssetForAction } from '../../content/public.js';
import type { FenceOwnAccount, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ReadReportableRoomMessage } from '../../rooms/public.js';
import type { ReadPublicPeople, ReadReportableMessage } from '../../social/public.js';

export interface ReceiptKey {
  readonly commandId: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly outcomeVersion: number;
}

/** What the personal receipt store says about a command key (see infrastructure/receipts). */
export type ReceiptLookup =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly outcome: unknown }
  | { readonly kind: 'key_reused' }
  | { readonly kind: 'epoch_mismatch' }
  | { readonly kind: 'outcome_version_newer' }
  | { readonly kind: 'outcome_version_older' };

export type ReportKind = 'content_error' | 'abuse';
export type ReportTargetKind = 'asset' | 'message' | 'room_message' | 'person';

/** One report as stored. Exactly the fields its target kind uses are set (the table checks it). */
export interface NewReport {
  readonly reportId: string;
  readonly reporterAccountId: string;
  readonly kind: ReportKind;
  readonly category: string;
  readonly targetKind: ReportTargetKind;
  readonly assetId?: string;
  readonly assetRevision?: number;
  readonly messageId?: string;
  readonly roomId?: string;
  readonly reportedAccountId?: string;
  readonly anchor?: Readonly<Record<string, unknown>>;
  readonly note?: string;
  readonly createdAt: Date;
}

/** `feedback.reports`, written inside the reporter's personal scope. */
export interface ReportStore {
  /** How many reports the account has sent at or after `since`. */
  countSince(scope: PersonalScopeTx, accountId: string, since: Date): Promise<number>;
  insert(scope: PersonalScopeTx, report: NewReport): Promise<void>;
}

export interface ReportPorts {
  readonly withScope: WithPersonalScope;
  /** Own root, then own account: precedes every row, so a report cannot race the account's deletion. */
  readonly fenceOwn: FenceOwnAccount;
  readonly hash: (operation: string, request: unknown) => string;
  readonly findReceipt: (scope: PersonalScopeTx, key: ReceiptKey) => Promise<ReceiptLookup>;
  readonly insertReceipt: (scope: PersonalScopeTx, key: ReceiptKey) => Promise<void>;
  readonly completeReceipt: (
    scope: PersonalScopeTx,
    commandId: string,
    outcome: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  /** The caller's view of an asset, already limited to what they may reach. */
  readonly findAsset: FindAssetForAction;
  readonly readMessage: ReadReportableMessage;
  readonly readRoomMessage: ReadReportableRoomMessage;
  readonly readPeople: ReadPublicPeople;
  readonly reports: ReportStore;
  readonly newId: () => string;
  readonly now: () => Date;
}
