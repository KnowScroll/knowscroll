import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { BufferKey, BufferedSelection, PreparedBuffer } from '../domain/buffer.js';
import type { JevPool } from '../domain/jev-pool.js';
import type {
  ComposerDecision,
  ComposerSnapshot,
  EncounterRef,
  PreparedEvidenceInput,
  SemanticAssessments,
} from '../domain/types.js';
export type ComposeEncounter = (snapshot: ComposerSnapshot) => ComposerDecision;
/** Implemented by Personal Context compatibility read; missing topic history stays explicit and neutral. */
export type ReadPreparedEvidenceInput = (
  scope: PersonalScopeTx,
  query: {
    readonly evaluatedAt: string;
    readonly topicIds: readonly string[];
    /** Optional exact candidate IDs: complete bounded Hide checks, never a truncated global list. */
    readonly candidateAssetIds?: readonly string[];
    /** At most100 candidate units with at most16 real admitted facets each. */
    readonly candidates: readonly { readonly explanationUnitId: string; readonly facets: readonly string[] }[];
  },
) => Promise<PreparedEvidenceInput | undefined>;
export interface DecisionBinding {
  readonly decisionId: string;
  readonly commandId: string;
  readonly sessionId?: string;
  readonly intentRevision?: number;
}
export type PersistComposerDecision = (
  scope: PersonalScopeTx,
  binding: DecisionBinding,
  decision: ComposerDecision,
) => Promise<'stored' | 'replayed'>;
/** Authenticated operator adapter only. It rechecks the composition root's allowlist and own live scope. */
export type ReadComposerDecision = (
  scope: PersonalScopeTx,
  decisionId: string,
) => Promise<
  { readonly binding: DecisionBinding; readonly decision: ComposerDecision; readonly inputSha256: string } | undefined
>;
export type PruneComposerDecisions = (scope: PersonalScopeTx, limit: number) => Promise<number>;
export interface ComposerOperatorAccess {
  readonly isOperator: (authority: PersonalAuthority) => boolean;
}

/**
 * What Experience tells the buffer worker about an activated offer. Experience owns sessions,
 * offers and activations; Composer reads them only through this port.
 */
export interface BufferSourceFacts {
  readonly intentRevision: number;
  /** The session's declared client capabilities, as stored. */
  readonly capabilities: unknown;
  /** The exact content the offer presented. */
  readonly source: EncounterRef;
  /** A region-scoped offer's next move inherits an immutable region constraint and is never buffered. */
  readonly regionScoped: boolean;
}
/** `undefined` unless the offer was really activated in this session at this exposure. */
export type ReadBufferSource = (
  scope: PersonalScopeTx,
  query: { readonly sessionId: string; readonly offerId: string; readonly exposureId: string },
) => Promise<BufferSourceFacts | undefined>;
/** The subset of `assetIds` the person has hidden or marked "Not interested" (at most 100 per call). */
export type ReadHiddenAssets = (scope: PersonalScopeTx, assetIds: readonly string[]) => Promise<readonly string[]>;

/** The stored buffer for exactly this key, expired or not; the caller applies the lifetimes. */
export type ReadComposerBuffer = (scope: PersonalScopeTx, key: BufferKey) => Promise<PreparedBuffer | undefined>;
export interface StoreComposerBuffer {
  (
    scope: PersonalScopeTx,
    buffer: {
      readonly key: BufferKey;
      readonly decisionId: string;
      readonly selection: readonly BufferedSelection[];
      readonly preparedAt: Date;
      readonly expiresAt: Date;
      readonly assessments?: SemanticAssessments;
    },
  ): Promise<void>;
}
/**
 * Ends a buffer. `served`: the navigation that used it committed its own offers, which now
 * reference the decision, so only the buffer row goes. `discarded`: nothing used it, so its
 * decision goes too.
 */
export type ReleaseComposerBuffer = (
  scope: PersonalScopeTx,
  decisionId: string,
  how: 'served' | 'discarded',
) => Promise<void>;
/**
 * Deletes the person's buffer and its decision once nothing in it can be used again: it is past its
 * life and carries no still-valid assessment. Also deletes the person's stored Jev assessments once every
 * one is past its life. Called by the navigation that would otherwise read the buffer, and by
 * `pruneComposerDecisions`.
 */
export type PurgeExpiredComposerBuffer = (scope: PersonalScopeTx, now: Date) => Promise<void>;
/** Enqueues, in the caller's transaction, the job that prepares the buffer for this key. */
export type RequestBufferPreparation = (scope: PersonalScopeTx, key: BufferKey) => Promise<void>;

/** The person's stored Jev assessments (`composer.jev_assessments`), expired or not; the caller applies the lifetimes. */
export type ReadJevPool = (scope: PersonalScopeTx) => Promise<JevPool | undefined>;
/**
 * Adds assessments the model just produced to the person's pool, merged with what the pool holds at
 * that moment (the caller holds the personal lock, so two preparations cannot lose each other's
 * entries). Entries past their life and entries made by another role version or model are dropped.
 */
export type StoreJevAssessments = (scope: PersonalScopeTx, added: JevPool, now: Date) => Promise<void>;
