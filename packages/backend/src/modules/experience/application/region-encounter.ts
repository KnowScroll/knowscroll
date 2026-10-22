import {
  RegionEncounterPreviewRequestSchema,
  RegionEncounterPreviewResponseSchema,
  RegionEncounterOpenRequestSchema,
  RegionEncounterOpenResponseSchema,
  type RegionEncounterPreviewResponse,
  type RegionEncounterOpenResponse,
  type ProblemCode,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import type { NavigationPorts, NavigateEncounter } from './navigation-ports.js';

export type RegionEncounterResult<T> =
  { readonly kind: 'accepted'; readonly value: T } | { readonly kind: 'refused'; readonly code: ProblemCode };
export interface RegionEncounterUseCases {
  readonly preview: (
    authority: PersonalAuthority,
    input: unknown,
  ) => Promise<RegionEncounterResult<RegionEncounterPreviewResponse>>;
  readonly open: (
    authority: PersonalAuthority,
    input: unknown,
  ) => Promise<RegionEncounterResult<RegionEncounterOpenResponse>>;
}
const refused = (code: ProblemCode) => ({ kind: 'refused', code }) as const;

/** A pin read has no session, offer, receipt, exposure, decision, root stamp, hint or work.
 * Deliberate Open delegates to the existing two-transaction Composer/activation engine. */
export function makeRegionEncounters(p: NavigationPorts, navigate: NavigateEncounter): RegionEncounterUseCases {
  return {
    async preview(authority, input) {
      const parsed = RegionEncounterPreviewRequestSchema.safeParse(input);
      if (!parsed.success) return refused('INVALID_REQUEST');
      const q = parsed.data;
      const entered = await p.withPersonalScope(
        authority,
        async (scope): Promise<RegionEncounterResult<RegionEncounterPreviewResponse>> => {
          const region = await p.readRegionConstraint(scope, q.target);
          if (region.kind === 'refused') return refused('UNIVERSE_UNAVAILABLE');
          const common = {
            version: 'region-encounter-preview.v1' as const,
            readId: q.readId,
            scope: {
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              personalWatermark: scope.revisionAtEntry,
            },
            target: q.target,
            capabilities: q.capabilities,
            recordedAt: p.now().toISOString(),
            geographyRevision:
              region.kind === 'read' ? region.constraint.target.expectedGeographyRevision : region.geographyRevision,
          };
          const unavailable = (reason: Extract<RegionEncounterPreviewResponse, { status: 'unavailable' }>['reason']) =>
            ({
              kind: 'accepted',
              value: RegionEncounterPreviewResponseSchema.parse({ ...common, status: 'unavailable', reason }),
            }) as const;
          if (region.kind !== 'read') return unavailable(region.reason);
          const selection = await p.readRegionCandidates(scope, {
            topicId: region.constraint.topicId,
            facetId: region.constraint.facetId,
            truthStatus: region.constraint.truthStatus,
            capabilities: q.capabilities,
          });
          if (selection.kind !== 'read') return unavailable('unsupported_region');
          const hidden = await p.readHidden(
            scope,
            selection.candidates.map((c) => c.encounter.assetId),
          );
          const candidate = selection.candidates.find((c) => !hidden.includes(c.encounter.assetId));
          if (!candidate) return unavailable(selection.hasMore ? 'selection_unavailable' : 'no_eligible_content');
          const ref = { assetId: candidate.encounter.assetId, assetRevision: candidate.encounter.assetRevision };
          if (
            !(await p.lockRegionCandidates(scope, {
              topicId: region.constraint.topicId,
              facetId: region.constraint.facetId,
              truthStatus: region.constraint.truthStatus,
              capabilities: q.capabilities,
              candidates: [{ ref, coverage: candidate.coverage }],
            }))
          )
            return unavailable('temporarily_unavailable');
          const exact = await p.readExactEncounter(scope, { ...ref, capabilities: q.capabilities });
          if (!exact) return unavailable('temporarily_unavailable');
          return {
            kind: 'accepted',
            value: RegionEncounterPreviewResponseSchema.parse({
              ...common,
              status: 'available',
              encounter: { ...ref, metadata: exact.metadata },
            }),
          };
        },
      );
      return entered.kind === 'entered'
        ? entered.value
        : refused(entered.refusal.kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
    },
    async open(claimed, input) {
      const parsed = RegionEncounterOpenRequestSchema.safeParse(input);
      if (!parsed.success) return refused('INVALID_REQUEST');
      const command = parsed.data;
      const authority = Object.freeze({ ...claimed, actor: Object.freeze({ ...claimed.actor }) });
      const result = await navigate(authority, command);
      if (result.kind === 'refused') return result;
      if (
        result.outcome.commandId !== command.commandId ||
        (command.session &&
          (result.outcome.sessionId !== command.session.sessionId ||
            result.outcome.intentRevision !== command.session.expectedIntentRevision + 1))
      )
        return refused('INTERNAL');
      return {
        kind: 'accepted',
        value: RegionEncounterOpenResponseSchema.parse({
          version: 'region-encounter-open.v1',
          universeId: authority.universeId,
          privacyEpoch: authority.privacyEpoch,
          target: command.target,
          capabilities: command.capabilities,
          ...(command.expectedEncounter ? { expectedEncounter: command.expectedEncounter } : {}),
          outcome: result.outcome,
        }),
      };
    },
  };
}
