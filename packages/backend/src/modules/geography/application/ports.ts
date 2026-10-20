import type {
  GeographyRevisions,
  GeographyAlias,
  UniverseDelta,
  ReadGeography,
  GeographySnapshot,
  ReadUniverseDeltas,
  UniverseDeltas,
} from '@knowscroll/contracts';
import type {
  WithPersonalScope,
  PersonalScopeTx,
  PersonalAuthority,
  CheckPersonalOwnerActive,
} from '../../identity/public.js';
import type {
  ReadCoverageInputs,
  ReadTrustedCoverage,
  TrustedCoverageQuery,
  TrustedCoverageRead,
} from '../../personal-context/public.js';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { GeographyProposal, FormationFacts, Place, Route } from '../domain/policy.js';
import type { CartographyJob, PublishDeltaJob } from '../events.js';
export interface GeographyState extends GeographyRevisions {
  readonly desiredRevision: number;
  readonly materialRevision: number;
  readonly publishedRevision: number;
  readonly activeRunId?: string;
}
export interface GeographyView {
  readonly state: GeographyState;
  readonly objects: readonly Place[];
  readonly routes: readonly Route[];
  readonly aliases: readonly GeographyAlias[];
}
export interface GeographyContext {
  readonly version: 'cartographer-context.v1';
  readonly transitionId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly desiredRevision: number;
  readonly pcRevision: number;
  readonly scopeRevision: number;
  readonly probes: TrustedCoverageQuery['probes'];
  readonly facts: FormationFacts;
  readonly factsSha256: string;
  readonly coverage: TrustedCoverageRead;
  readonly base: GeographyRevisions;
  readonly routeIds: Readonly<Record<string, string>>;
}
export interface GeographyRun {
  readonly id: string;
  readonly desiredRevision: number;
  readonly status: 'queued' | 'prepared' | 'blocked' | 'unknown' | 'accepted' | 'rejected' | 'stale' | 'insufficient';
  readonly claimId?: string;
  readonly claimUntil?: string;
  readonly context?: GeographyContext;
  readonly proposal?: GeographyProposal;
  readonly attemptId?: string;
  readonly outcome?: string;
}
export interface GeographyStore {
  state(scope: PersonalScopeTx): Promise<GeographyState>;
  writeState(scope: PersonalScopeTx, state: GeographyState): Promise<void>;
  view(scope: PersonalScopeTx): Promise<GeographyView>;
  run(scope: PersonalScopeTx, id: string): Promise<GeographyRun | undefined>;
  writeRun(scope: PersonalScopeTx, run: GeographyRun): Promise<void>;
  findDelta(
    scope: PersonalScopeTx,
    transitionId: string,
  ): Promise<{ readonly hash: string; readonly delta: UniverseDelta } | undefined>;
  deltas(scope: PersonalScopeTx, after: number, limit: number): Promise<readonly UniverseDelta[]>;
  saveObject(scope: PersonalScopeTx, object: Place, supportRefs: readonly string[]): Promise<void>;
  saveRoute(scope: PersonalScopeTx, route: Route, supportRefs: readonly string[]): Promise<void>;
  writeDelta(scope: PersonalScopeTx, runId: string, hash: string, delta: UniverseDelta): Promise<void>;
}
export interface GeographyPorts {
  readonly withScope: WithPersonalScope;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly store: GeographyStore;
  readonly readInputs: ReadCoverageInputs;
  readonly readTrusted: ReadTrustedCoverage;
  readonly hash: (value: unknown) => string;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly enqueue: (
    scope: PersonalScopeTx,
    runId: string,
    delayed?: { readonly expectedClaimId: string; readonly startAfter: Date },
  ) => Promise<void>;
  readonly enqueueDelta: (scope: PersonalScopeTx, delta: UniverseDelta) => Promise<void>;
  readonly notify: (scope: PersonalScopeTx, revision: number, eventId: string) => Promise<void>;
  readonly receipts: {
    find(
      scope: PersonalScopeTx,
      commandId: string,
      input: unknown,
    ): Promise<
      { readonly kind: 'new' | 'refused' } | { readonly kind: 'replay'; readonly outcome: RequestCartographyResult }
    >;
    insert(scope: PersonalScopeTx, commandId: string, input: unknown): Promise<void>;
    complete(scope: PersonalScopeTx, commandId: string, outcome: RequestCartographyResult): Promise<void>;
  };
}
export interface CartographerPorts extends GeographyPorts {
  readonly harness: ReasoningHarness;
  readonly enabled: () => boolean;
  /** Separate reviewed economic permission, never inferred from feature flag or credentials. */
  readonly permitted: (scope: PersonalScopeTx) => Promise<boolean>;
}
export type MaterialGeographyChange = (
  scope: PersonalScopeTx,
  input: { readonly sourceRevision: number },
) => Promise<void>;
export type RequestCartographyResult =
  | {
      readonly kind: 'accepted';
      readonly runId: string;
      readonly desiredRevision: number;
      readonly privacyEpoch: number;
      readonly revision: number;
    }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'command_key_reused' | 'run_not_resumable' };
export type RequestCartography = (
  authority: PersonalAuthority,
  command: { readonly commandId: string; readonly resumeRunId?: string },
) => Promise<RequestCartographyResult>;
export type RunCartographer = (job: CartographyJob, signal: AbortSignal) => Promise<void>;
export type PublishGeographyDelta = (job: PublishDeltaJob) => Promise<void>;
export type ReadOwnGeography = (
  authority: PersonalAuthority,
  query: ReadGeography,
) => Promise<
  | { readonly kind: 'read'; readonly snapshot: GeographySnapshot }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'selection_not_found' }
>;
export type ReadOwnDeltas = (
  authority: PersonalAuthority,
  query: ReadUniverseDeltas,
) => Promise<
  | { readonly kind: 'read'; readonly deltas: UniverseDeltas }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' }
>;
