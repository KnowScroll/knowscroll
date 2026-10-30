import {
  LOOK_LIMITS,
  PLANET_TYPES,
  SCENE_LOOK_VERSION,
  WORLD_GENERATOR_VERSION,
  seededUnit,
  type HazeFamily,
  type PlanetLook,
  type PlanetType,
  type RegionLook,
  type SceneLook,
  type SystemLook,
} from '@knowscroll/contracts';
import { CONCEPTS, hazeFamilyOf } from '../../content/public.js';

/**
 * The rule that gives each place its look, once (D-077, D-078, D-102, D-103). It is pure: the same
 * subjects and the same earlier looks always give the same new looks, and it reads nothing about
 * activity, evidence or time. A look it has given is never given again, so what is "in use now" can
 * never change a planet that already has one.
 */

/** One object of a universe, as the rule sees it. */
export interface LookSubject {
  readonly objectId: string;
  readonly kind: 'system' | 'star' | 'planet' | 'region';
  readonly parentId: string;
  /** The system the object belongs to; a system is its own. */
  readonly systemId: string;
  /** The canonical catalogue id the object was formed from. */
  readonly meaningId: string;
  /** The object's persistent 32-hex seed. */
  readonly seed: string;
}

/** The plan and the stored objects disagree, so no look can be given without guessing. */
export class LookRefused extends Error {
  constructor(readonly reason: string) {
    super(`SCENE_LOOK_REFUSED:${reason}`);
    this.name = 'LookRefused';
  }
}

/**
 * Seed channels of the look rule. `silhouette.v1` owns 0 and 1; changing a channel or a constant
 * below changes every look assigned from now on, so it is a new rule version, not an edit.
 */
const TYPE_ORDER_CHANNEL = 16;
const HUE_CHANNEL = 32;
const RINGS_CHANNEL = 33;
const MOON_CHANNEL = 34;
/** The design's hue turn per haze family: a planet's colours lean toward the haze of its system. */
const HAZE_HUE_SHIFT: Readonly<Record<HazeFamily, number>> = {
  teal: 0,
  cobalt: 18,
  coral: -18,
  amber: -10,
  pink: 25,
  violet: 30,
};
/**
 * A repeated type turns its hue by this many degrees (alternately one way and the other, a step further
 * each time) so it cannot be mistaken for the first planet of that type. The first one leans toward its
 * system's haze instead; the two never overlap, because the haze lean and the jitter stay within 45 degrees.
 */
const REPEAT_HUE_STEP = 75;
const HUE_JITTER = 30;
const FROZEN_RINGS_BELOW = 0.5;
const MOON_BELOW = 0.45;

const KIND_RANK = { system: 0, star: 1, planet: 2, region: 3 } as const;
const byCreation = (a: LookSubject, b: LookSubject) =>
  KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0);

/** Which types a universe already uses, and which a system already holds. */
class TypeUse {
  private readonly counts = new Map<PlanetType, number>();
  private readonly bySystem = new Map<string, Set<PlanetType>>();

  add(systemId: string, type: PlanetType): void {
    this.counts.set(type, this.count(type) + 1);
    const held = this.bySystem.get(systemId) ?? new Set<PlanetType>();
    held.add(type);
    this.bySystem.set(systemId, held);
  }
  count(type: PlanetType): number {
    return this.counts.get(type) ?? 0;
  }
  holds(systemId: string, type: PlanetType): boolean {
    return this.bySystem.get(systemId)?.has(type) ?? false;
  }
}

/** The six types in an order that depends only on the planet's seed (a seeded Fisher-Yates shuffle). */
function shuffledTypes(seed: string): PlanetType[] {
  const order = [...PLANET_TYPES];
  for (let index = order.length - 1; index > 0; index--) {
    const swapWith = Math.floor(seededUnit(seed, TYPE_ORDER_CHANNEL + index) * (index + 1));
    [order[index], order[swapWith]] = [order[swapWith]!, order[index]!];
  }
  return order;
}

/**
 * The type for a new planet: the least-used one in the universe, and among equals one the system
 * does not hold yet, and among those the first in the planet's own seeded order. Six planets
 * therefore get six types, and from the seventh the counts stay within one of each other.
 */
function chooseType(seed: string, use: TypeUse, systemId: string): PlanetType {
  let best: PlanetType | undefined;
  let bestKey: readonly [number, number] = [Infinity, Infinity];
  for (const type of shuffledTypes(seed)) {
    const key = [use.count(type), use.holds(systemId, type) ? 1 : 0] as const;
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = type;
      bestKey = key;
    }
  }
  return best!;
}

/** A turn of the colour wheel as a whole number of degrees in [-180, 180). */
function wrapDegrees(degrees: number): number {
  return ((((Math.round(degrees) + 180) % 360) + 360) % 360) - 180;
}

/** The hue turn of the nth planet of a type: its haze lean first, then alternating repeat steps. */
function hueFor(variant: number, haze: HazeFamily, jitter: number): number {
  if (variant === 0) return wrapDegrees(HAZE_HUE_SHIFT[haze] + jitter);
  const turn = Math.ceil(variant / 2) * REPEAT_HUE_STEP;
  return wrapDegrees((variant % 2 === 1 ? turn : -turn) + jitter);
}

function planetLook(
  subject: LookSubject,
  type: PlanetType,
  variant: number,
  haze: HazeFamily,
  siteCount: number,
): PlanetLook {
  const jitter = Math.round((seededUnit(subject.seed, HUE_CHANNEL) - 0.5) * HUE_JITTER);
  return {
    schemaVersion: SCENE_LOOK_VERSION,
    generatorVersion: WORLD_GENERATOR_VERSION,
    objectId: subject.objectId,
    kind: 'planet',
    type,
    rings: type === 'gas' || (type === 'frozen' && seededUnit(subject.seed, RINGS_CHANNEL) < FROZEN_RINGS_BELOW),
    moon: seededUnit(subject.seed, MOON_CHANNEL) < MOON_BELOW,
    hueShift: hueFor(variant, haze, jitter),
    variant,
    siteCount,
  };
}

/**
 * Gives a look to every system, planet and region in `subjects` that has none in `existing`, in
 * creation order (kind, then object id, which is creation order for UUIDv7 ids). Stars have none. A
 * planet takes one site per facet of its catalogue entry; a region takes the ordinal of its facet.
 * It never changes or repeats a look in `existing`. Throws `LookRefused` when the plan and the
 * objects disagree.
 */
export function assignLooks(subjects: readonly LookSubject[], existing: readonly SceneLook[]): SceneLook[] {
  const subjectOf = new Map(subjects.map((subject) => [subject.objectId, subject]));
  const known = new Map(existing.map((look) => [look.objectId, look]));
  const use = new TypeUse();
  for (const look of existing) {
    const subject = subjectOf.get(look.objectId);
    if (!subject) throw new LookRefused('look_without_object');
    if (look.kind === 'planet') use.add(subject.systemId, look.type);
  }
  const created: SceneLook[] = [];
  const pending = subjects.filter((subject) => subject.kind !== 'star' && !known.has(subject.objectId));
  for (const subject of [...pending].sort(byCreation)) {
    const look =
      subject.kind === 'system'
        ? systemLook(subject)
        : subject.kind === 'planet'
          ? newPlanetLook(subject, subjectOf, use)
          : regionLook(subject, subjectOf, known);
    known.set(look.objectId, look);
    created.push(look);
  }
  return created;
}

function systemLook(subject: LookSubject): SystemLook {
  const haze = hazeFamilyOf(subject.meaningId);
  if (!haze) throw new LookRefused('system_without_haze');
  return {
    schemaVersion: SCENE_LOOK_VERSION,
    generatorVersion: WORLD_GENERATOR_VERSION,
    objectId: subject.objectId,
    kind: 'system',
    haze,
  };
}

function newPlanetLook(subject: LookSubject, subjectOf: ReadonlyMap<string, LookSubject>, use: TypeUse): PlanetLook {
  const system = subjectOf.get(subject.systemId);
  const haze = system && hazeFamilyOf(system.meaningId);
  const facets = CONCEPTS.find((concept) => concept.id === subject.meaningId)?.facets.length ?? 0;
  if (!haze || facets < 1 || facets > LOOK_LIMITS.sites) throw new LookRefused('planet_without_plan');
  const type = chooseType(subject.seed, use, subject.systemId);
  const variant = use.count(type);
  use.add(subject.systemId, type);
  return planetLook(subject, type, variant, haze, facets);
}

function regionLook(
  subject: LookSubject,
  subjectOf: ReadonlyMap<string, LookSubject>,
  known: ReadonlyMap<string, SceneLook>,
): RegionLook {
  const planet = known.get(subject.parentId);
  const planetMeaning = subjectOf.get(subject.parentId)?.meaningId;
  const site = CONCEPTS.find((concept) => concept.id === planetMeaning)?.facets.findIndex(
    (facet) => facet.id === subject.meaningId,
  );
  // A site beyond the planet's recorded count means the plan grew after the planet was drawn: refuse
  // rather than lay a region on a site its planet's world was never given.
  if (planet?.kind !== 'planet' || site === undefined || site < 0 || site >= planet.siteCount)
    throw new LookRefused('region_without_site');
  return {
    schemaVersion: SCENE_LOOK_VERSION,
    generatorVersion: WORLD_GENERATOR_VERSION,
    objectId: subject.objectId,
    kind: 'region',
    site,
  };
}
