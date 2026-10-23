import type { ProblemCode, RegionEncounterOpenRequest } from '@knowscroll/contracts';
import type { EncounterRef } from '../../content/public.js';
import type { GeographyRegionConstraint } from '../../geography/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { JsonValue } from './ports.js';
import type { NavigationCommand, NavigationPorts, NavigationResult, StoredOffer } from './navigation-ports.js';

/** Small helpers shared by the navigation steps. */

export const ref = (r: EncounterRef): EncounterRef => ({ assetId: r.assetId, assetRevision: r.assetRevision });
export const same = (a: EncounterRef, b: EncounterRef) =>
  a.assetId === b.assetId && a.assetRevision === b.assetRevision;
export const json = (value: unknown): { readonly [key: string]: JsonValue } =>
  JSON.parse(JSON.stringify(value)) as { readonly [key: string]: JsonValue };
export const refuse = (code: ProblemCode): NavigationResult => ({ kind: 'refused', code });
export const scopeCode = (kind: string): ProblemCode =>
  kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE';
export const isRegionOpen = (command: NavigationCommand): command is RegionEncounterOpenRequest =>
  !('intent' in command) && command.target.kind === 'region';
export const sameRegion = (p: NavigationPorts, a: GeographyRegionConstraint, b: GeographyRegionConstraint) =>
  p.hashRequest('region-constraint', json(a)) === p.hashRequest('region-constraint', json(b));

/** A vertical move inherits its actual source offer's immutable region, never mutable intent. */
export async function commandRegion(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
): Promise<{ kind: 'region'; value: GeographyRegionConstraint } | { kind: 'none' } | NavigationResult> {
  let expected: GeographyRegionConstraint | undefined;
  if ('intent' in command && command.intent.mode === 'vertical') {
    const member = await p.readMember(scope, command.sessionId, command.from.offerId, command.from.exposureId);
    expected = member?.offer.regionConstraint?.region;
  }
  const target = isRegionOpen(command) ? command.target : expected?.target;
  if (!target) return { kind: 'none' };
  const live = await p.readRegionConstraint(scope, target);
  if (live.kind !== 'read') return refuse(live.kind === 'refused' ? 'UNIVERSE_UNAVAILABLE' : 'OFFER_UNAVAILABLE');
  if (expected && !sameRegion(p, expected, live.constraint)) return refuse('OFFER_UNAVAILABLE');
  return { kind: 'region', value: live.constraint };
}

/** Historical descriptors remain data, never a bypass of current region/mapping/access/Hide. */
export async function currentRegionOffers(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  offers: readonly StoredOffer[],
  capabilities: unknown,
): Promise<boolean> {
  const first = offers[0]?.regionConstraint;
  if (!first) return !offers.some((o) => o.regionConstraint !== undefined);
  if (offers.some((o) => !o.regionConstraint || !sameRegion(p, first.region, o.regionConstraint.region))) return false;
  const live = await p.readRegionConstraint(scope, first.region.target);
  if (live.kind !== 'read' || !sameRegion(p, live.constraint, first.region)) return false;
  if (
    !(await p.lockRegionCandidates(scope, {
      topicId: first.region.topicId,
      facetId: first.region.facetId,
      truthStatus: first.region.truthStatus,
      capabilities,
      candidates: offers.map((o) => ({ ref: ref(o.descriptor), coverage: o.regionConstraint!.coverage })),
    }))
  )
    return false;
  return !(
    await p.readHidden(
      scope,
      offers.map((o) => o.descriptor.assetId),
    )
  ).length;
}
