import type {
  GeographyRevisions,
  PlanetType,
  SceneRevisions,
  SceneSkySystem,
  FormationPresentationFact,
  ProblemCode,
  FormationPresentationRead,
  FormationPresentationClaimAcceptance,
  FormationPresentationAcknowledgement,
  SceneDescriptor,
  SceneLook,
  SceneChunk,
  SceneManifestRead,
  SceneChunkRead,
  ReadSceneManifest,
  ReadSceneChunk,
  ReadSceneSky,
  SceneSkyRead,
} from '@knowscroll/contracts';
import type {
  WithPersonalScope,
  PersonalScopeTx,
  PersonalAuthority,
  CheckPersonalOwnerActive,
} from '../../identity/public.js';
import type { Catalogue } from '../../content/public.js';
import type { ReadGeographyChangedSystems, ReadGeographySceneInput } from '../../geography/public.js';
import type { SceneLayout } from '../domain/layout.js';
import type { LogEvent } from '../../../infrastructure/observability/index.js';
import type { BackfillLooksJob, ProjectSceneJob } from '../events.js';
export interface StoredObject {
  readonly descriptor: SceneDescriptor;
  readonly systemId: string;
  readonly chunkId: string;
  /**
   * `canonical-lattice.v1`: the lattice slot, for ever. `canonical-lattice.v2`: a planet's system-local ordinal, and
   * null for every other object (a system's cell is in `SystemRow`).
   */
  readonly slot: number | null;
  readonly layout: SceneLayout;
}
export interface StoredChunk {
  readonly systemId: string;
  readonly chunk: SceneChunk;
}
/** One current chunk of a system as a manifest names it. */
export interface ChunkHead {
  readonly systemId: string;
  readonly chunkId: string;
  readonly sceneRevision: number;
  readonly objectIds: readonly string[];
}
/** The sky's row of one system: where it sits on the coarse grid, how many it holds, when anything of it last changed. */
export interface SystemRow {
  readonly systemId: string;
  /** The coarse grid cell of a `canonical-lattice.v2` system; null for a system that keeps its v1 slot. */
  readonly cell: number | null;
  readonly planetCount: number;
  readonly objectCount: number;
  readonly sceneRevision: number;
}
/** Where the next system goes: past the older layout's objects, on the next free coarse cell. */
export interface SceneLayoutState {
  readonly legacyReach: number;
  readonly nextCell: number;
}
/**
 * The pinned policy, the private seed and what was last projected. No manifest and no route membership: a system's
 * manifest is its chunks' newest versions, and a route lives in its system's chunks (D-417).
 */
export interface SceneState {
  readonly policyVersion: 'canonical-lattice.v1' | 'canonical-lattice.v2';
  readonly worldSeed: string;
  /** The Geography stamps and scene revision of the last projection that reached the whole map. */
  readonly projected?: SceneRevisions;
  readonly layout: SceneLayoutState;
  readonly failure?: { readonly geographyRevision: number; readonly reason: 'limit' | 'temporarily_unavailable' };
  /** The stored payload is still the whole-map shape of an older projector; `adopt` makes it the current one. */
  readonly legacy?: boolean;
}
/** A system as the sky serves it, before the capability decides whether its haze is sent. */
export interface SkyRow extends Omit<SceneSkySystem, 'haze'> {
  readonly haze?: NonNullable<SceneSkySystem['haze']>;
}
/** What an old client needs to be sure it can hold the whole map. */
export interface LegacyFit {
  readonly objects: number;
  /** The widest anchor of any object, per axis. */
  readonly anchor: number;
  readonly variant: number;
}
export interface SceneStore {
  state(scope: PersonalScopeTx): Promise<SceneState | undefined>;
  /** Makes an old-shape state the current one (the SQL `scenes.adopt_legacy_layout`); moves nothing. */
  adopt(scope: PersonalScopeTx): Promise<void>;
  /** The sky rows of exactly these systems. */
  systems(scope: PersonalScopeTx, systemIds: readonly string[]): Promise<readonly SystemRow[]>;
  /** Every stored object of these systems. */
  objectsOfSystems(scope: PersonalScopeTx, systemIds: readonly string[]): Promise<readonly StoredObject[]>;
  /** The stored objects with these ids, whatever their system. */
  objectsById(scope: PersonalScopeTx, ids: readonly string[]): Promise<readonly StoredObject[]>;
  /** The newest version of each chunk of these systems, empty ones included. */
  currentChunks(scope: PersonalScopeTx, systemIds: readonly string[]): Promise<readonly StoredChunk[]>;
  /** The chunks a manifest names: the newest version of each chunk that holds anything, by chunk id; one system or all. */
  chunkHeads(scope: PersonalScopeTx, systemId?: string): Promise<readonly ChunkHead[]>;
  /** The newest version of one chunk id, empty or not. */
  currentChunk(scope: PersonalScopeTx, chunkId: string): Promise<StoredChunk | undefined>;
  /** One exact chunk version, and whether it is still the newest of its chunk id. */
  chunk(
    scope: PersonalScopeTx,
    id: string,
    revision: number,
  ): Promise<(StoredChunk & { readonly current: boolean }) | undefined>;
  /** The looks of these objects; each is assigned once and never rewritten. */
  looksOf(scope: PersonalScopeTx, objectIds: readonly string[]): Promise<readonly SceneLook[]>;
  /** How many planets of each type the universe holds: the look rule's "least used" in one aggregate. */
  planetTypeCounts(scope: PersonalScopeTx): Promise<ReadonlyMap<PlanetType, number>>;
  /** Inserts looks for objects already stored; an existing look is left as it is. */
  saveLooks(scope: PersonalScopeTx, looks: readonly SceneLook[]): Promise<void>;
  /** Inserts new objects and takes a changed label or activity of an existing one; nothing else of an object changes. */
  saveObjects(scope: PersonalScopeTx, objects: readonly StoredObject[]): Promise<void>;
  /** Appends new immutable chunk versions. */
  saveChunks(scope: PersonalScopeTx, chunks: readonly StoredChunk[]): Promise<void>;
  /** Inserts or updates sky rows; objects of the systems are stored first. */
  saveSystems(scope: PersonalScopeTx, rows: readonly SystemRow[]): Promise<void>;
  saveState(scope: PersonalScopeTx, state: SceneState): Promise<void>;
  /** A savepoint in the projection's transaction, so a refused batch leaves nothing behind. */
  mark(scope: PersonalScopeTx): Promise<void>;
  rollback(scope: PersonalScopeTx): Promise<void>;
  /** The sky: systems in id order after `after`, optionally only those changed after a scene revision. */
  sky(
    scope: PersonalScopeTx,
    query: { readonly after?: string; readonly limit: number; readonly since?: number },
  ): Promise<readonly SkyRow[]>;
  /** The system ids of the universe in id order after `after`: how a maintenance pass walks the map. */
  systemIds(scope: PersonalScopeTx, after: string | undefined, limit: number): Promise<readonly string[]>;
  /** What an old client has to hold if it is served the whole map. */
  legacyFit(scope: PersonalScopeTx): Promise<LegacyFit>;
  pending(
    scope: PersonalScopeTx,
  ): Promise<{ readonly geographyRevision: number; readonly personalRevision: number } | undefined>;
}
export interface ScenePorts {
  /** The topic catalogue (D-419): a use case reads one release of it and uses that release for the whole job. */
  readonly catalogue: Catalogue;
  readonly withScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly readInput: ReadGeographySceneInput;
  readonly readChangedSystems: ReadGeographyChangedSystems;
  readonly store: SceneStore;
  readonly seed: () => string;
  readonly hash: (value: unknown) => string;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (scope: PersonalScopeTx, revision: number) => Promise<void>;
  readonly now: () => Date;
  /** Diagnostics only: a region left without a look, or a plan that disagrees with the stored objects. */
  readonly logEvent: LogEvent;
}
export type ProjectScene = (job: ProjectSceneJob) => Promise<void>;
/** Gives the looks a world projected before looks existed; returns how many it gave. */
export type BackfillSceneLooks = (job: BackfillLooksJob) => Promise<{ readonly assigned: number }>;
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

export type ReadOwnSceneSky = (
  authority: PersonalAuthority,
  query: ReadSceneSky,
) => Promise<
  | { readonly kind: 'read'; readonly scene: SceneSkyRead }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' }
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
  readonly scenes: Pick<SceneStore, 'state' | 'objectsById' | 'currentChunk' | 'pending'>;
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
