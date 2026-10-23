import type {
  GeographyRevisions,
  FormationPresentationFact,
  ProblemCode,
  FormationPresentationRead,
  FormationPresentationClaimAcceptance,
  FormationPresentationAcknowledgement,
  SceneDescriptor,
  SceneManifest,
  SceneChunk,
  SceneManifestRead,
  SceneChunkRead,
  ReadSceneManifest,
  ReadSceneChunk,
} from '@knowscroll/contracts';
import type {
  WithPersonalScope,
  PersonalScopeTx,
  PersonalAuthority,
  CheckPersonalOwnerActive,
} from '../../identity/public.js';
import type { ReadGeographySceneInput } from '../../geography/public.js';
import type { ProjectSceneJob } from '../events.js';
export interface StoredObject {
  readonly descriptor: SceneDescriptor;
  readonly systemId: string;
  readonly chunkId: string;
  readonly slot: number;
}
export interface StoredChunk {
  readonly systemId: string;
  readonly chunk: SceneChunk;
}
export interface RouteChunk {
  readonly routeId: string;
  readonly systemId: string;
  readonly chunkId: string;
}
export interface SceneState {
  readonly policyVersion: 'canonical-lattice.v1';
  readonly routeChunks: readonly RouteChunk[];
  readonly worldSeed: string;
  readonly manifest?: SceneManifest;
  readonly failure?: { readonly geographyRevision: number; readonly reason: 'limit' | 'temporarily_unavailable' };
}
export interface SceneStore {
  state(scope: PersonalScopeTx): Promise<SceneState | undefined>;
  objects(scope: PersonalScopeTx): Promise<readonly StoredObject[]>;
  chunk(scope: PersonalScopeTx, id: string, revision: number): Promise<StoredChunk | undefined>;
  save(
    scope: PersonalScopeTx,
    state: SceneState,
    objects: readonly StoredObject[],
    changed: readonly StoredChunk[],
  ): Promise<void>;
  pending(
    scope: PersonalScopeTx,
  ): Promise<{ readonly geographyRevision: number; readonly personalRevision: number } | undefined>;
}
export interface ScenePorts {
  readonly withScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly readInput: ReadGeographySceneInput;
  readonly store: SceneStore;
  readonly seed: () => string;
  readonly hash: (value: unknown) => string;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (scope: PersonalScopeTx, revision: number) => Promise<void>;
  readonly now: () => Date;
}
export type ProjectScene = (job: ProjectSceneJob) => Promise<void>;
export type ReadOwnSceneManifest = (
  authority: PersonalAuthority,
  query: ReadSceneManifest,
) => Promise<
  | { readonly kind: 'read'; readonly scene: SceneManifestRead }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'selection_not_found' }
>;
export type ReadOwnSceneChunk = (
  authority: PersonalAuthority,
  query: ReadSceneChunk,
) => Promise<
  | { readonly kind: 'read'; readonly scene: SceneChunkRead }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'selection_not_found' | 'reference_not_found' }
>;

/** Durable presentation is a delivery fact, never formation or learning authority. */
export interface FormationRecord {
  readonly key: string;
  readonly transitionId: string;
  readonly recordedAt: string;
  readonly geography: GeographyRevisions;
  readonly targetCount: number;
  readonly fact?: FormationPresentationFact;
  readonly limit: boolean;
  readonly claim?: {
    readonly claimId: string;
    readonly attemptNonce: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  };
  readonly terminal?: { readonly disposition: 'shown' | 'skipped'; readonly recordedAt: string };
}
export type NewFormationRecord = Omit<FormationRecord, 'key' | 'claim' | 'terminal'>;
export interface FormationStore {
  record(scope: PersonalScopeTx, record: NewFormationRecord): Promise<void>;
  read(
    scope: PersonalScopeTx,
    target: { readonly kind: 'next' } | { readonly kind: 'transition'; readonly transitionId: string },
  ): Promise<FormationRecord | undefined>;
  claim(scope: PersonalScopeTx, transitionId: string, claim: NonNullable<FormationRecord['claim']>): Promise<void>;
  terminal(
    scope: PersonalScopeTx,
    transitionId: string,
    claimId: string,
    disposition: 'shown' | 'skipped',
    recordedAt: string,
  ): Promise<boolean>;
}
export type FormationResult<T> =
  { readonly kind: 'accepted'; readonly value: T } | { readonly kind: 'refused'; readonly code: ProblemCode };
export interface FormationUseCases {
  read(authority: PersonalAuthority, input: unknown): Promise<FormationResult<FormationPresentationRead>>;
  claim(authority: PersonalAuthority, input: unknown): Promise<FormationResult<FormationPresentationClaimAcceptance>>;
  acknowledge(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<FormationResult<FormationPresentationAcknowledgement>>;
  expire(input: unknown): Promise<void>;
  recover(input: unknown): Promise<{ readonly completed: number; readonly skipped: number }>;
}

export interface FormationReceiptKey {
  readonly commandId: string;
  readonly operation: 'scenes.formation-claim' | 'scenes.formation-acknowledge';
  readonly requestHash: string;
  readonly outcomeVersion: 1;
}
export interface FormationRecoveryCandidate {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly transitionId: string;
  readonly claimId: string;
}
export interface FormationPorts {
  readonly withScope: WithPersonalScope;
  readonly withRecoveryScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly readInput: ReadGeographySceneInput;
  readonly scenes: Pick<SceneStore, 'state' | 'chunk' | 'pending'>;
  readonly store: FormationStore;
  readonly receipts: {
    find(
      scope: PersonalScopeTx,
      key: FormationReceiptKey,
    ): Promise<
      | { readonly kind: 'new' }
      | { readonly kind: 'replay'; readonly outcome: unknown }
      | { readonly kind: 'refused'; readonly code: ProblemCode }
    >;
    insert(scope: PersonalScopeTx, key: FormationReceiptKey): Promise<void>;
    complete(scope: PersonalScopeTx, commandId: string, outcome: unknown): Promise<void>;
  };
  readonly hash: (operation: string, input: unknown) => string;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (scope: PersonalScopeTx, revision: number) => Promise<void>;
  readonly enqueueExpiry: (
    scope: PersonalScopeTx,
    candidate: FormationRecoveryCandidate,
    expiresAt: Date,
  ) => Promise<void>;
  /** Commits at most one advancing fixed-queue continuation BEFORE returning this bounded page. */
  readonly readRecoveryPage: (input: unknown) => Promise<readonly FormationRecoveryCandidate[]>;
  readonly newId: () => string;
  readonly now: () => Date;
}
