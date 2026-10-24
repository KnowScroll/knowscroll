/**
 * Where a room's station sits on a person's own map: beside the system (or planet) of its topic that
 * the person's Geography has established. Pure: no database, clock or crypto. A placement is personal
 * and is neither membership nor ownership of the room (blueprint §10, "RoomPlacement").
 */

/** The part of an established Geography object a placement needs. */
export interface PlaceableObject {
  readonly id: string;
  readonly kind: 'system' | 'star' | 'planet' | 'region';
  readonly truthStatus: 'factual' | 'hypothetical';
  /** The object's catalogue meaning, which a room's topic names. */
  readonly meaningId: string;
  readonly parent: { readonly id: string };
}

export interface Placement {
  readonly topic: { readonly kind: 'system' | 'planet'; readonly id: string };
  readonly systemId: string;
  readonly planetId?: string;
}

/**
 * The places of a map that a room could be bound to: every factual system, and every factual planet
 * whose system the map holds. A hypothetical place never carries a shared room: a room belongs to a
 * library topic, not to what one person imagined.
 */
export function placementsOf(objects: readonly PlaceableObject[]): readonly Placement[] {
  const systems = objects.filter((object) => object.kind === 'system' && object.truthStatus === 'factual');
  const systemIds = new Set(systems.map((system) => system.id));
  return [
    ...systems.map((system): Placement => ({ topic: { kind: 'system', id: system.meaningId }, systemId: system.id })),
    ...objects
      .filter(
        (object) => object.kind === 'planet' && object.truthStatus === 'factual' && systemIds.has(object.parent.id),
      )
      .map((planet): Placement => ({
        topic: { kind: 'planet', id: planet.meaningId },
        systemId: planet.parent.id,
        planetId: planet.id,
      })),
  ];
}
