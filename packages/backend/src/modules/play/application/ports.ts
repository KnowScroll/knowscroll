import type { HasActivatedExposure } from '../../experience/public.js';
import type { ReadScrollCalls } from '../../content/public.js';
import type {
  FenceOwnAccount,
  FencePersonalRecording,
  PersonalScopeTx,
  RecordingScopeTx,
  WithPersonalScope,
} from '../../identity/public.js';
import type { Tally } from '../domain/results.js';

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

/** One lock as stored: the option the person locked and whether it was right. */
export interface StoredCall {
  readonly stopId: string;
  readonly option: number;
  readonly correct: boolean;
}

export interface NewCall extends StoredCall {
  readonly assetId: string;
  readonly revision: number;
  readonly commandId: string;
}

/** Everything the person has on one Scroll revision: the calls in the order locked, and the tally. */
export interface StoredPlay {
  readonly calls: readonly StoredCall[];
  readonly tally: Tally;
}

/** `play.calls` and `play.scroll_results`. Reads use the personal scope; writes need the recording capability. */
export interface PlayStore {
  /** The person's calls and tally on one revision; nothing locked is no calls and a zero tally. */
  readPlay(scope: PersonalScopeTx, assetId: string, revision: number): Promise<StoredPlay>;
  /** Stores a first lock and replaces the tally, in the caller's transaction. */
  insertCall(scope: RecordingScopeTx, call: NewCall, tally: Tally): Promise<void>;
}

export interface PlayPorts {
  readonly withPersonalScope: WithPersonalScope;
  /** Own root, then own account: precedes every row, so a lock cannot race the account's deletion. */
  readonly fenceOwn: FenceOwnAccount;
  /** Whether new personal contributions may be stored now (D-057, D-083). */
  readonly fenceRecording: FencePersonalRecording;
  readonly hash: (operation: string, request: unknown) => string;
  readonly findReceipt: (scope: PersonalScopeTx, key: ReceiptKey) => Promise<ReceiptLookup>;
  readonly insertReceipt: (scope: PersonalScopeTx, key: ReceiptKey) => Promise<void>;
  readonly completeReceipt: (
    scope: PersonalScopeTx,
    commandId: string,
    outcome: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly hasActivatedExposure: HasActivatedExposure;
  readonly readCalls: ReadScrollCalls;
  readonly store: PlayStore;
}
