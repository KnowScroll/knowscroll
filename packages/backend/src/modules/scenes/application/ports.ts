import type {
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
