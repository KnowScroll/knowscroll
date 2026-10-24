import type { SceneDescriptor, SceneFamily, ScenePalette } from '@knowscroll/scene-core';
import type { VisitedSystem } from '@knowscroll/client-core';

/**
 * Draws a friend's published list (systems and planets under public identities) with the Universe's
 * own renderer. The list carries no position, family, seed or anything about reading, so this device
 * invents all of that from the public identities alone: a place keeps its spot and look as long as it
 * stays shared, and nothing about it says where the owner's own map keeps it, how big it is, or whether
 * anything is hidden (U06, D-027). Pure: no React, no clock, no randomness.
 */

/** Spacing of the lattice slots, as the projector's own (a planet one step out is the inner orbit). */
const LATTICE = 300;
const FAMILIES: readonly SceneFamily[] = ['terraced.v1', 'ridged.v1', 'archipelago.v1'];
/** The projector's convention: the family picks the colour set. */
const PALETTES: Record<SceneFamily, ScenePalette> = {
  'terraced.v1': 'ochre',
  'ridged.v1': 'sage',
  'archipelago.v1': 'cobalt',
};
const LAYER = { system: 0, star: 1, planet: 2 } as const;
/** Planet slots around a star: eight directions on each of the three orbits the system view draws. */
const PLANET_SLOTS = 24;

/** FNV-1a over the characters, mixed with a salt so one identity gives several independent numbers. */
function hash(text: string, salt: number): number {
  let value = (0x811c9dc5 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  for (const character of text) {
    value ^= character.codePointAt(0)!;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}
const unit = (text: string, salt: number) => hash(text, salt) / 0x1_0000_0000;
const hex32 = (text: string) =>
  [0, 1, 2, 3]
    .map((salt) =>
      hash(text, 100 + salt)
        .toString(16)
        .padStart(8, '0'),
    )
    .join('');
/** A UUID-shaped identity derived from a public one, for the parts of a drawing that have no public identity of their own. */
function derivedId(text: string): string {
  const digits = hex32(text);
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${digits.slice(20, 32)}`;
}
const round = (value: number) => Math.round(value * 100) / 100;

interface Slot {
  readonly x: number;
  readonly y: number;
}

/**
 * A square lattice around the middle, nearest the middle first, large enough that most slots stay
 * free. Five by five serves up to eight systems, so the first few shares never reshuffle the map; it
 * only grows (to the next odd side) past that.
 */
function systemSlots(count: number): readonly Slot[] {
  const needed = Math.ceil(Math.sqrt(count * 3));
  const side = Math.max(5, needed % 2 === 0 ? needed + 1 : needed);
  const middle = (side - 1) / 2;
  const slots: Slot[] = [];
  for (let row = 0; row < side; row += 1)
    for (let column = 0; column < side; column += 1)
      slots.push({ x: (column - middle) * LATTICE, y: (row - middle) * LATTICE });
  return slots.sort(
    (a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x),
  );
}

/** The slot an identity prefers, or the next free one after it. Identities are taken in a fixed order. */
function takeSlot(id: string, count: number, taken: Set<number>): number {
  const start = hash(id, 7) % count;
  for (let step = 0; step < count; step += 1) {
    const candidate = (start + step) % count;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  return start;
}

/** A planet's offset from its star: direction and orbit from the slot, one lattice step per orbit. */
function planetOffset(slot: number): Slot {
  const orbit = Math.floor(slot / 8) % 3;
  const angle = (slot % 8) * (Math.PI / 4) + orbit * (Math.PI / 8);
  return { x: Math.cos(angle) * LATTICE * (orbit + 1), y: Math.sin(angle) * LATTICE * (orbit + 1) };
}

/**
 * The renderer's descriptors for a list: a system and its star at the system's slot, and each planet
 * on a slot around the star. `ownerId` is the owner's public person ID, used only to name the whole
 * universe as the parent of every system.
 */
export function visitorDescriptors(ownerId: string, systems: readonly VisitedSystem[]): readonly SceneDescriptor[] {
  const universeId = derivedId(`universe:${ownerId}`);
  const slots = systemSlots(systems.length);
  const taken = new Set<number>();
  const descriptors: SceneDescriptor[] = [];
  const base = (
    kind: SceneDescriptor['kind'],
    objectId: string,
    parentId: string,
    label: string,
    family: SceneFamily,
    anchor: Slot,
  ): SceneDescriptor => ({
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId,
    parentId,
    kind,
    originTransitionId: derivedId(`origin:${objectId}`),
    label,
    truthStatus: 'factual',
    activity: { availability: 'unavailable' },
    family,
    seed: hex32(objectId),
    palette: PALETTES[family],
    material: 'solid',
    atmosphere: { density: round(0.3 + 0.4 * unit(objectId, 5)) },
    detail: { roughness: round(0.25 + 0.5 * unit(objectId, 6)) },
    anchor: {
      x: anchor.x,
      y: anchor.y,
      layer: LAYER[kind === 'star' ? 'star' : kind === 'planet' ? 'planet' : 'system'],
    },
    target: { kind, objectId },
  });
  for (const system of [...systems].sort((a, b) => (a.publicSystemId < b.publicSystemId ? -1 : 1))) {
    const family = FAMILIES[hash(system.publicSystemId, 3) % FAMILIES.length]!;
    const place = slots[takeSlot(system.publicSystemId, slots.length, taken)]!;
    descriptors.push(base('system', system.publicSystemId, universeId, system.label, family, place));
    descriptors.push(
      base('star', derivedId(`star:${system.publicSystemId}`), system.publicSystemId, system.label, family, place),
    );
    const used = new Set<number>();
    for (const planet of [...system.planets].sort((a, b) => (a.publicPlanetId < b.publicPlanetId ? -1 : 1))) {
      const offset = planetOffset(takeSlot(planet.publicPlanetId, PLANET_SLOTS, used));
      descriptors.push(
        base('planet', planet.publicPlanetId, system.publicSystemId, planet.label, family, {
          x: place.x + offset.x,
          y: place.y + offset.y,
        }),
      );
    }
  }
  return descriptors;
}
