import type {
  AskQuickAnswer,
  AskQuickAnswerResult,
  DismissQuickAnswerResult,
  QuickAnswerStatus,
} from '@knowscroll/contracts';
import type {
  CheckPersonalOwnerActive,
  FencePersonalRecording,
  PersonalAuthority,
  PersonalScopeTx,
  WithPersonalScope,
} from '../../identity/public.js';
import type { ReadScrollQuickAnswerFacts } from '../../content/public.js';
import type { HasActivatedExposure } from '../../experience/public.js';

export type QuickAnswerState = 'waiting' | 'answered' | 'unavailable' | 'dismissed';

/** One Quick answer as its row holds it. The words the person asked are present only while `waiting`. */
export interface QuickAnswerRow {
  readonly id: string;
  readonly privacyEpoch: number;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly stopId: string;
  readonly state: QuickAnswerState;
  readonly passage: string | undefined;
  readonly question: string | undefined;
  readonly shownQuestion: string | undefined;
  readonly answer: string | undefined;
  readonly covered: boolean | undefined;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface NewQuickAnswer {
  readonly id: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly stopId: string;
  readonly passage: string;
  readonly question: string | undefined;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** What settles a waiting answer. Either way the words the person asked are cleared in the same statement. */
export type QuickAnswerSettlement =
  | { readonly kind: 'answered'; readonly question: string; readonly answer: string; readonly covered: boolean }
  | { readonly kind: 'unavailable' };

export interface QuickAnswerStore {
  /** Takes the lock that serialises the create decisions of every person, so the day's counts and the rows admitted agree. Last in the lock order. */
  lockCaps(scope: PersonalScopeTx): Promise<void>;
  insert(scope: PersonalScopeTx, row: NewQuickAnswer): Promise<void>;
  read(scope: PersonalScopeTx, id: string): Promise<QuickAnswerRow | undefined>;
  /** Settles a row that is still waiting. False when it is not (dismissed, erased or already settled): the late answer is dropped. */
  settle(scope: PersonalScopeTx, id: string, settlement: QuickAnswerSettlement, at: Date): Promise<boolean>;
  /** Closes the card and clears its words. Idempotent. */
  dismiss(scope: PersonalScopeTx, id: string): Promise<void>;
  /** The person's answers asked since `since`, every state: what their daily cap counts. */
  countSince(scope: PersonalScopeTx, since: Date): Promise<number>;
  /**
   * The person's answers still waiting and asked after `youngerThan`: what bounds the jobs they can queue. A row older than
   * the wait limit is no longer waited for by anyone, so it never holds a place (the worker or the purge settles it).
   */
  countWaiting(scope: PersonalScopeTx, youngerThan: Date): Promise<number>;
}

/** Quartermaster's ledger of Quick answers: an ID and a time, no person and no words (migration 0094). */
export interface QuickAnswerLedger {
  /** Answers asked since `since` by anyone: what the world's daily cap counts. */
  countSince(scope: PersonalScopeTx, since: Date): Promise<number>;
  insert(scope: PersonalScopeTx, id: string): Promise<void>;
}

export type QuickAnswerRefusal =
  | 'scope_refused'
  | 'command_key_reused'
  | 'receipt_unavailable'
  /** The Scroll, the stop or the words are not ones this person has open (or the revision is held). */
  | 'source_unavailable'
  | 'not_found'
  /** An answer is tied to what the person is reading, so it is refused while recording is paused (D-254). */
  | 'recording_paused'
  | 'recording_stale';

export type QuickAnswerResult<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly reason: QuickAnswerRefusal };

/**
 * What a report about a Quick answer keeps of it: its question and answer, or nothing when it is not the reporter's own,
 * not answered, past its day, or about another Scroll revision. Read inside the reporter's own personal scope.
 */
export type ReadQuickAnswerForReport = (
  scope: PersonalScopeTx,
  input: { readonly quickAnswerId: string; readonly assetId: string; readonly assetRevision: number },
) => Promise<string | undefined>;

export type AskQuickAnswerUseCase = (
  authority: PersonalAuthority,
  command: AskQuickAnswer,
) => Promise<QuickAnswerResult<AskQuickAnswerResult>>;
export type ReadQuickAnswerUseCase = (
  authority: PersonalAuthority,
  input: { readonly quickAnswerId: string },
) => Promise<QuickAnswerResult<QuickAnswerStatus>>;
export type DismissQuickAnswerUseCase = (
  authority: PersonalAuthority,
  input: { readonly quickAnswerId: string },
) => Promise<QuickAnswerResult<DismissQuickAnswerResult>>;

/** The job a worker answers: IDs only, never the words. */
export interface AnswerQuickAnswerJob {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly quickAnswerId: string;
}
export type AnswerQuickAnswerUseCase = (job: AnswerQuickAnswerJob, signal: AbortSignal) => Promise<void>;

export interface QuickAnswerPorts {
  readonly withScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  /** Whether the person has opened this exact Scroll revision: they can only ask about what they met. */
  readonly hasActivatedExposure: HasActivatedExposure;
  readonly readFacts: ReadScrollQuickAnswerFacts;
  readonly fenceRecording: FencePersonalRecording;
  readonly store: QuickAnswerStore;
  readonly ledger: QuickAnswerLedger;
  /** Quick answers per UTC day for the world (0 turns them off) and for one person. */
  readonly caps: { readonly perDay: number; readonly perPersonPerDay: number };
  readonly receipts: {
    find(
      scope: PersonalScopeTx,
      commandId: string,
      command: AskQuickAnswer,
    ): Promise<
      | { readonly kind: 'new' }
      | { readonly kind: 'replay'; readonly outcome: unknown }
      | { readonly kind: 'refused'; readonly reason: 'command_key_reused' | 'receipt_unavailable' }
    >;
    insert(scope: PersonalScopeTx, commandId: string, command: AskQuickAnswer): Promise<void>;
    complete(scope: PersonalScopeTx, commandId: string, receipt: AskQuickAnswerResult): Promise<void>;
  };
  /** Sends the answering job in the caller's transaction; a repeat for the same answer is a no-op. */
  readonly enqueue: (scope: PersonalScopeTx, quickAnswerId: string) => Promise<void>;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (scope: PersonalScopeTx, revision: number, eventId: string) => Promise<void>;
  readonly newId: () => string;
  /** A UUID derived from a name: the same name is the same ID, so a redelivery names the runs it already made. */
  readonly idFor: (name: string) => string;
  readonly now: () => Date;
}
