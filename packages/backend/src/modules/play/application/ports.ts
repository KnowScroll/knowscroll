import type { HasActivatedExposure } from '../../experience/public.js';
import type { ReadScrollPlayFacts } from '../../content/public.js';
import type {
  FenceOwnAccount,
  FencePersonalRecording,
  PersonalScopeTx,
  RecordingScopeTx,
  WithPersonalScope,
} from '../../identity/public.js';
import type { LandmarkTier, Tally } from '../domain/results.js';

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

/** A landmark as the person earned it: the key and name the Scroll gave, and the finish. */
export interface StoredLandmark {
  readonly key: string;
  readonly name: string;
  readonly tier: LandmarkTier;
}

export interface NewLandmark extends StoredLandmark {
  readonly assetId: string;
  readonly revision: number;
}

/** A landmark in the person's list: where and when it was earned. */
export interface LandmarkListing extends NewLandmark {
  readonly earnedAt: Date;
}

/** Everything the person has on one Scroll revision: the calls in the order locked, the tally and the landmark earned. */
export interface StoredPlay {
  readonly calls: readonly StoredCall[];
  readonly tally: Tally;
  /** Present once the Final call of a revision that names a landmark was locked. */
  readonly landmark?: StoredLandmark | undefined;
}

/** `play.calls`, `play.scroll_results` and `play.landmarks`. Reads use the personal scope; writes need the recording capability. */
export interface PlayStore {
  /** The person's calls, tally and landmark on one revision; nothing locked is no calls and a zero tally. */
  readPlay(scope: PersonalScopeTx, assetId: string, revision: number): Promise<StoredPlay>;
  /** Stores a first lock and replaces the tally, in the caller's transaction. */
  insertCall(scope: RecordingScopeTx, call: NewCall, tally: Tally): Promise<void>;
  /** Awards a landmark once: an award that already exists is left as it was. */
  insertLandmark(scope: RecordingScopeTx, landmark: NewLandmark): Promise<void>;
  /** The person's own landmarks, newest first. */
  listLandmarks(scope: PersonalScopeTx): Promise<readonly LandmarkListing[]>;
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
  readonly readFacts: ReadScrollPlayFacts;
  readonly store: PlayStore;
}
