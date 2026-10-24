/**
 * Who may visit a universe and what a visitor is shown of it (blueprint §17, D-027, D-047).
 * Pure rules over plain values; nothing here reads a table or knows about a request.
 */
export type Audience =
  | { readonly mode: 'nobody' }
  | { readonly mode: 'chosen_friends'; readonly friendAccountIds: ReadonlySet<string> }
  | { readonly mode: 'all_friends' };

/**
 * Whether the owner's audience includes a visitor who is a friend right now. The caller has already
 * checked the friendship: a chosen-friends row alone never grants a visit.
 */
export function audienceAllows(audience: Audience, visitorAccountId: string): boolean {
  switch (audience.mode) {
    case 'nobody':
      return false;
    case 'all_friends':
      return true;
    case 'chosen_friends':
      return audience.friendAccountIds.has(visitorAccountId);
  }
}

/** The kinds of place Geography holds; visitors are only ever shown systems and their planets. */
export interface GeographyPlace {
  readonly id: string;
  readonly kind: 'system' | 'star' | 'planet' | 'region';
  readonly parentId: string;
  readonly label: string;
  readonly truthStatus: 'factual' | 'hypothetical';
}

/** A system the owner could share, as they see it in their own settings. */
export interface OwnSystem {
  readonly systemId: string;
  readonly label: string;
}

/** A planet or system as visitors know it: a random public identity and the owner's own word. */
export interface PublishedPlanet {
  readonly planetId: string;
  readonly publicPlanetId: string;
  readonly label: string;
}
export interface PublishedSystem {
  readonly systemId: string;
  readonly publicSystemId: string;
  readonly label: string;
  readonly planets: readonly PublishedPlanet[];
}

/** Most systems a person may share, and planets in each; the contract's limits. */
export const PUBLISH_LIMITS = { systems: 100, planetsPerSystem: 100 } as const;

/** Case-insensitive, by code unit: the same order in every process, whatever its locale data. */
const byLabel = <T extends { readonly label: string }>(a: T, b: T): number => {
  const [left, right] = [a.label.toLowerCase(), b.label.toLowerCase()];
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * The factual systems whose labels are fit to show another person. A hypothetical system (a What-if
 * the person made) is not offered: it is theirs to explore, not a place they have been.
 */
export function shareableSystems(
  places: readonly GeographyPlace[],
  isPublicLabel: (label: string) => boolean,
): readonly OwnSystem[] {
  return places
    .filter((p) => p.kind === 'system' && p.truthStatus === 'factual' && isPublicLabel(p.label))
    .map((p) => ({ systemId: p.id, label: p.label }))
    .sort(byLabel)
    .slice(0, PUBLISH_LIMITS.systems);
}

/**
 * What visitors are shown for the chosen systems: each system with its factual planets, never stars,
 * regions, hypothetical places, routes, positions or anything about reading. A public identity is
 * kept while its place stays shared and is made new otherwise, so unsharing and sharing again cannot
 * be linked. `newPublicId` must return a random identifier unrelated to any private one.
 *
 * Systems and planets come out sorted by label: the order says nothing about when they formed.
 */
export function planPublication(
  places: readonly GeographyPlace[],
  chosenSystemIds: ReadonlySet<string>,
  current: readonly PublishedSystem[],
  isPublicLabel: (label: string) => boolean,
  newPublicId: () => string,
): readonly PublishedSystem[] {
  const knownSystems = new Map(current.map((s) => [s.systemId, s]));
  const knownPlanets = new Map(current.flatMap((s) => s.planets.map((p) => [p.planetId, p] as const)));
  const planned: PublishedSystem[] = [];
  for (const system of shareableSystems(places, isPublicLabel)) {
    if (!chosenSystemIds.has(system.systemId)) continue;
    const planets = places
      .filter(
        (p) =>
          p.kind === 'planet' &&
          p.parentId === system.systemId &&
          p.truthStatus === 'factual' &&
          isPublicLabel(p.label),
      )
      .map((p) => ({
        planetId: p.id,
        publicPlanetId: knownPlanets.get(p.id)?.publicPlanetId ?? newPublicId(),
        label: p.label,
      }))
      .sort(byLabel)
      .slice(0, PUBLISH_LIMITS.planetsPerSystem);
    planned.push({
      systemId: system.systemId,
      publicSystemId: knownSystems.get(system.systemId)?.publicSystemId ?? newPublicId(),
      label: system.label,
      planets,
    });
  }
  return planned;
}

/** Whether visitors would see a different list: the same places under the same identities and words are not a change. */
export function publicationChanged(before: readonly PublishedSystem[], after: readonly PublishedSystem[]): boolean {
  const visible = (systems: readonly PublishedSystem[]) =>
    JSON.stringify(
      systems.map((s) => [s.publicSystemId, s.label, s.planets.map((p) => [p.publicPlanetId, p.label]).sort()]).sort(),
    );
  return visible(before) !== visible(after);
}
