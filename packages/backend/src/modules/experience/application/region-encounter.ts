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
import { readWithheld } from './navigation-support.js';
import { formatLeaning } from '../../composer/public.js';
import type { RegionEncounterCandidate } from '../../content/public.js';

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
 * Deliberate Open delegates to the existing two-transaction Composer/activation engine.
 * A region shows one explanation: its covering Scroll and, when it has one, that Scroll's Reel twin (#709, D-404). The
 * format the person leans to in the topic comes first; the other is the `alternate` a client asked for. Both are
 * locked, so either opens exactly. */
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
          const hidden = await readWithheld(
            p,
            scope,
            selection.candidates.map((c) => c.encounter.assetId),
            false,
          );
          const visible = selection.candidates.filter((c) => !hidden.includes(c.encounter.assetId));
          const first = visible[0];
          if (!first) return unavailable(selection.hasMore ? 'selection_unavailable' : 'no_eligible_content');
          // One explanation: the candidates under the first visible one's covering Scroll (that Scroll, its Reel twin).
          const twins = visible.filter(
            (c) =>
              c.coverage.assetId === first.coverage.assetId &&
              c.coverage.assetRevision === first.coverage.assetRevision,
          );
          const lean =
            twins.length > 1
              ? formatLeaning(
                  await p.readPrepared(scope, {
                    evaluatedAt: p.now().toISOString(),
                    topicIds: [region.constraint.topicId],
                    candidates: [],
                  }),
                  region.constraint.topicId,
                )
              : undefined;
          const primary = twins.find((c) => c.encounter.kind === (lean ?? 'scroll')) ?? first;
          const other = q.alternate ? twins.find((c) => c !== primary) : undefined;
          const shown = other ? [primary, other] : [primary];
          const refOf = (c: RegionEncounterCandidate) => ({
            assetId: c.encounter.assetId,
            assetRevision: c.encounter.assetRevision,
          });
          if (
            !(await p.lockRegionCandidates(scope, {
              topicId: region.constraint.topicId,
              facetId: region.constraint.facetId,
              truthStatus: region.constraint.truthStatus,
              capabilities: q.capabilities,
              candidates: shown.map((c) => ({ ref: refOf(c), coverage: c.coverage })),
            }))
          )
            return unavailable('temporarily_unavailable');
          const exact = await Promise.all(
            shown.map((c) => p.readExactEncounter(scope, { ...refOf(c), capabilities: q.capabilities })),
          );
          if (exact.some((e) => !e)) return unavailable('temporarily_unavailable');
          return {
            kind: 'accepted',
            value: RegionEncounterPreviewResponseSchema.parse({
              ...common,
              status: 'available',
              encounter: { ...refOf(primary), metadata: exact[0]!.metadata },
              ...(other ? { alternate: { ...refOf(other), metadata: exact[1]!.metadata } } : {}),
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
