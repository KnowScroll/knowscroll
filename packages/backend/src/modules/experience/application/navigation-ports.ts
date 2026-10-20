import type { ActivateExposureResponse } from '@knowscroll/contracts';
import type {
  ActivateOfferRequest,
  EncounterOffer,
  ExposureContextResponse,
  NavigateExperienceRequest,
  NavigationOutcome,
  OpenDiscoveryRequest,
  OpenRevisitRequest,
  ProblemCode,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type {
  ReadDiscoveryCandidates,
  ReadExactEncounter,
  ReadContinuations,
  ResolveContinuityLink,
  ReadEncounterAttribution,
  EncounterRef,
  EncounterAttribution,
} from '../../content/public.js';
import type { ComposeEncounter, PersistComposerDecision, ReadPreparedEvidenceInput } from '../../composer/public.js';
import type { CommandPorts, JsonValue, NewExposure } from './ports.js';
export interface ComposerSession {
  readonly id: string;
  readonly intentRevision: number;
  readonly capabilities: JsonValue;
  readonly privacyEpoch: number;
}
export interface StoredOffer {
  readonly id: string;
  readonly sessionId: string;
  readonly intentRevision: number;
  readonly privacyEpoch: number;
  readonly descriptor: EncounterOffer;
  readonly mode: 'vertical' | 'series' | 'related' | 'variant' | 'return';
  readonly source?: { readonly offerId: string; readonly exposureId: string };
  readonly link?: { readonly linkId: string; readonly revision: number };
  readonly expiresAt: string;
}
export interface ActivatedMember {
  readonly offer: StoredOffer;
  readonly exposureId: string;
  readonly activatedAt: string;
}
export interface ActivityLineage extends EncounterRef {
  readonly exposureId: string;
  readonly kind: 'reel' | 'scroll';
  readonly activatedAt: string;
  readonly explanationUnitId: string;
  readonly facets: readonly string[];
  readonly liked: boolean;
  readonly saved: boolean;
  readonly horizontal: boolean;
  readonly returned: boolean;
  readonly actionRevision: number;
  readonly navigationRevision: number;
}
export interface RoutingHistory {
  readonly recent: readonly {
    readonly exposureId: string;
    readonly activatedAt: string;
    readonly explanationUnitId: string;
    readonly facets: readonly string[];
  }[];
  readonly established: readonly {
    readonly explanationUnitId: string;
    readonly encountered: boolean;
    readonly facets: readonly { readonly facetId: string; readonly encountered: boolean }[];
  }[];
  readonly hiddenAssetIds: readonly string[];
}
export interface NavigationPorts extends CommandPorts {
  readonly readSession: (scope: PersonalScopeTx, id: string) => Promise<ComposerSession | undefined>;
  readonly writeSession: (
    scope: PersonalScopeTx,
    session: ComposerSession,
    intent: JsonValue,
    creates: boolean,
  ) => Promise<void>;
  readonly readOffer: (scope: PersonalScopeTx, id: string) => Promise<StoredOffer | undefined>;
  readonly readMember: (
    scope: PersonalScopeTx,
    sessionId: string,
    offerId: string,
    exposureId?: string,
  ) => Promise<ActivatedMember | undefined>;
  readonly insertOffers: (scope: PersonalScopeTx, offers: readonly StoredOffer[]) => Promise<void>;
  readonly bindOffer: (scope: PersonalScopeTx, offerId: string, exposureId: string) => Promise<void>;
  readonly readHidden: (scope: PersonalScopeTx, assetIds: readonly string[]) => Promise<readonly string[]>;
  readonly readDiscoveryCandidates: ReadDiscoveryCandidates;
  readonly readExactEncounter: ReadExactEncounter;
  readonly readContinuations: ReadContinuations;
  readonly resolveContinuityLink: ResolveContinuityLink;
  readonly readAttribution: ReadEncounterAttribution;
  readonly readPrepared: ReadPreparedEvidenceInput;
  readonly compose: ComposeEncounter;
  readonly persistDecision: PersistComposerDecision;
  readonly insertExposure: (scope: PersonalScopeTx, exposure: NewExposure) => Promise<void>;
  readonly markActivated: (scope: PersonalScopeTx, exposureId: string, at: Date) => Promise<void>;
  readonly recordActivation: (
    scope: PersonalScopeTx,
    exposureId: string,
    metadata: EncounterAttribution,
    offer?: StoredOffer,
  ) => Promise<void>;
  readonly enqueueActivity: (scope: PersonalScopeTx, exposureId: string) => Promise<void>;
  readonly advanceRevision: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (
    scope: PersonalScopeTx,
    change: { readonly revision: number; readonly eventId: string },
  ) => Promise<void>;
  readonly readContextBase: (
    scope: PersonalScopeTx,
    exposureId: string,
  ) => Promise<
    | {
        readonly ref: EncounterRef;
        readonly capabilities: JsonValue;
        readonly session?: { readonly sessionId: string; readonly intentRevision: number };
        readonly actions: ExposureContextResponse['actions'];
      }
    | undefined
  >;
}
export type NavigationCommand = OpenDiscoveryRequest | OpenRevisitRequest | NavigateExperienceRequest;
export type NavigationResult =
  | { readonly kind: 'accepted'; readonly outcome: NavigationOutcome }
  | { readonly kind: 'refused'; readonly code: ProblemCode };
export type NavigateEncounter = (authority: PersonalAuthority, command: NavigationCommand) => Promise<NavigationResult>;
export type ActivateOffer = (
  authority: PersonalAuthority,
  command: ActivateOfferRequest,
) => Promise<
  | { readonly kind: 'accepted'; readonly outcome: ActivateExposureResponse }
  | { readonly kind: 'refused'; readonly code: ProblemCode }
>;
export type ReadExposureContext = (
  authority: PersonalAuthority,
  exposureId: string,
) => Promise<
  | { readonly kind: 'read'; readonly context: ExposureContextResponse }
  | { readonly kind: 'refused'; readonly code: ProblemCode }
>;
