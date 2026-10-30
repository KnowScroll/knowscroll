import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PLANET_TYPES,
  SceneLookSchema,
  type PlanetLook,
  type PlanetType,
  type RegionLook,
  type SceneLook,
  type SystemLook,
} from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import { assignLooks, LookRefused, RESERVED_SITES, type LookSubject } from './assign-looks.js';

/**
 * Each planet's facets in the order a region's site is taken from (D-078, D-102). A region's site is the
 * position of its facet in this list, and the stored looks of every universe already built on it never
 * change, so the plan may only APPEND a facet to a planet: inserting or reordering one would put two
 * regions in one cell. Update this table only by appending, in the same change that appends the facet.
 */
const FACET_ORDER: Readonly<Record<string, readonly string[]>> = {
  'earth.seasons': [
    'earth.seasons.axial-tilt',
    'earth.seasons.hemispheres',
    'earth.seasons.limits',
    'earth.seasons.elsewhere',
  ],
  'earth.tides': ['earth.tides.forcing', 'earth.tides.alignment', 'earth.tides.coasts'],
  'earth.greenhouse-effect': [
    'earth.greenhouse-effect.radiation',
    'earth.greenhouse-effect.balance',
    'earth.greenhouse-effect.limits',
  ],
  'space.stars': ['space.stars.fusion', 'space.stars.lifecycle', 'space.stars.measurement'],
  'space.exoplanets': ['space.exoplanets.detection', 'space.exoplanets.habitability', 'space.exoplanets.diversity'],
  'space.black-holes': ['space.black-holes.formation', 'space.black-holes.horizon', 'space.black-holes.evidence'],
  'machine-learning.attention': [
    'machine-learning.attention.mechanism',
    'machine-learning.attention.example',
    'machine-learning.attention.limits',
  ],
  'machine-learning.transformers': [
    'machine-learning.transformers.architecture',
    'machine-learning.transformers.embeddings',
    'machine-learning.transformers.generation',
  ],
  'machine-learning.training': [
    'machine-learning.training.optimization',
    'machine-learning.training.examples',
    'machine-learning.training.generalization',
  ],
  'machine-learning.efficiency': [
    'machine-learning.efficiency.long-inputs',
    'machine-learning.efficiency.sparsity',
    'machine-learning.efficiency.tokens',
  ],
  'human-body.heart-and-blood': [
    'human-body.heart-and-blood.pumping',
    'human-body.heart-and-blood.pressure',
    'human-body.heart-and-blood.oxygen',
  ],
  'human-body.nervous-system': [
    'human-body.nervous-system.signal',
    'human-body.nervous-system.synapse',
    'human-body.nervous-system.reflex',
  ],
  'human-body.immune-system': [
    'human-body.immune-system.innate',
    'human-body.immune-system.adaptive',
    'human-body.immune-system.memory',
  ],
  'computing.web-requests': [
    'computing.web-requests.naming',
    'computing.web-requests.secure-transport',
    'computing.web-requests.caching',
  ],
  'computing.browsers': [
    'computing.browsers.rendering',
    'computing.browsers.event-loop',
    'computing.browsers.same-origin',
  ],
  'computing.algorithms': [
    'computing.algorithms.growth',
    'computing.algorithms.sorting',
    'computing.algorithms.hashing',
  ],
  'history.industrial-revolution': [
    'history.industrial-revolution.causes',
    'history.industrial-revolution.technology',
    'history.industrial-revolution.consequences',
    'history.industrial-revolution.interpretation',
  ],
};

/** The looks `assignLooks` gives; a test that needs the skipped regions reads the whole result. */
const assign = (subjects: readonly LookSubject[], existing: readonly SceneLook[]) =>
  assignLooks(subjects, existing).created;

// Authored CI subjects built from the real catalogue. They are not product geography.
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const seedOf = (n: number) => createHash('sha256').update(`ci-seed-${n}`).digest('hex').slice(0, 32);

interface World {
  readonly subjects: LookSubject[];
  readonly planets: readonly LookSubject[];
  readonly regionsOf: (planet: LookSubject) => LookSubject[];
}

/** Every system, star, planet and region of the catalogue, numbered in creation order (systems first). */
function catalogueWorld(): World {
  let next = 1;
  const subjects: LookSubject[] = [];
  const systems = new Map<string, LookSubject>();
  const make = (kind: LookSubject['kind'], meaningId: string, parent: LookSubject | undefined): LookSubject => {
    const n = next++;
    const subject: LookSubject = {
      objectId: id(n),
      kind,
      parentId: parent ? parent.objectId : id(0),
      systemId: kind === 'system' ? id(n) : parent!.systemId,
      meaningId,
      seed: seedOf(n),
    };
    subjects.push(subject);
    return subject;
  };
  for (const concept of CONCEPTS.filter((c) => c.parent === null)) {
    const system = make('system', concept.id, undefined);
    systems.set(concept.id, system);
    make('star', concept.id, system);
  }
  const planets: LookSubject[] = [];
  for (const concept of CONCEPTS.filter((c) => c.parent !== null)) {
    const planet = make('planet', concept.id, systems.get(concept.parent!));
    planets.push(planet);
    for (const facet of concept.facets) make('region', facet.id, planet);
  }
  return {
    subjects,
    planets,
    regionsOf: (planet) => subjects.filter((s) => s.kind === 'region' && s.parentId === planet.objectId),
  };
}

/** The subjects with only the named planets (and their regions): the universe before the others arrive. */
const onlyPlanets = (subjects: readonly LookSubject[], planets: readonly LookSubject[]) => {
  const named = new Set(planets.map((p) => p.objectId));
  return subjects.filter((s) =>
    s.kind === 'planet' ? named.has(s.objectId) : s.kind === 'region' ? named.has(s.parentId) : true,
  );
};
const planetLooks = (looks: readonly SceneLook[]) => looks.filter((l): l is PlanetLook => l.kind === 'planet');
const typesOf = (looks: readonly SceneLook[]) => planetLooks(looks).map((l) => l.type);
const byType = (looks: readonly SceneLook[]) => {
  const counts = new Map<PlanetType, number>(PLANET_TYPES.map((type) => [type, 0]));
  for (const look of planetLooks(looks)) counts.set(look.type, counts.get(look.type)! + 1);
  return counts;
};
/** Circular distance between two hue turns, in degrees. */
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));

describe('the look rule (authored CI subjects over the real catalogue)', () => {
  it('gives every system, planet and region a look that parses, and a star none', () => {
    const world = catalogueWorld();
    const looks = assign(world.subjects, []);
    const count = (kind: LookSubject['kind']) => world.subjects.filter((s) => s.kind === kind).length;
    expect(looks).toHaveLength(count('system') + count('planet') + count('region'));
    expect(looks.some((l) => world.subjects.find((s) => s.objectId === l.objectId)?.kind === 'star')).toBe(false);
    for (const look of looks) expect(SceneLookSchema.parse(look)).toEqual(look);
    expect(count('system')).toBe(6);
    expect(count('planet')).toBe(17);
  });

  it('takes each system haze from the library plan: six systems, six families', () => {
    const world = catalogueWorld();
    const hazes = assign(world.subjects, [])
      .filter((l): l is SystemLook => l.kind === 'system')
      .map((l) => l.haze);
    expect([...hazes].sort()).toEqual(['amber', 'cobalt', 'coral', 'pink', 'teal', 'violet']);
  });

  it('gives the first six planets six different types', () => {
    const { subjects, planets } = catalogueWorld();
    const looks = assign(onlyPlanets(subjects, planets.slice(0, 6)), []);
    expect(new Set(typesOf(looks)).size).toBe(6);
    expect(planetLooks(looks).every((l) => l.variant === 0)).toBe(true);
  });

  it('from the seventh planet gives the least-used type, so counts never differ by more than one', () => {
    const { subjects, planets } = catalogueWorld();
    let existing: SceneLook[] = [];
    for (const [index] of planets.entries()) {
      existing = [...existing, ...assign(onlyPlanets(subjects, planets.slice(0, index + 1)), existing)];
      const counts = [...byType(existing).values()];
      expect(Math.max(...counts) - Math.min(...counts), `after planet ${index + 1}`).toBeLessThanOrEqual(1);
    }
    const final = [...byType(existing).values()].sort();
    expect(final).toEqual([2, 3, 3, 3, 3, 3]);
    // The nth planet of a type records n - 1 in `variant`.
    for (const type of PLANET_TYPES)
      expect(
        planetLooks(existing)
          .filter((l) => l.type === type)
          .map((l) => l.variant),
      ).toEqual(Array.from({ length: byType(existing).get(type)! }, (_, v) => v));
  });

  it('prefers, among the least-used types, one the same system does not hold yet', () => {
    const { subjects, planets } = catalogueWorld();
    const named = (meaning: string) => planets.find((p) => p.meaningId === meaning)!;
    const first = [
      'machine-learning.attention',
      'machine-learning.transformers',
      'machine-learning.training',
      'earth.seasons',
      'earth.tides',
      'space.stars',
    ].map(named);
    const existing = assign(onlyPlanets(subjects, first), []);
    expect(new Set(typesOf(existing)).size).toBe(6);
    const efficiency = named('machine-learning.efficiency');
    const seventh = assign(onlyPlanets(subjects, [...first, efficiency]), existing).find(
      (l) => l.objectId === efficiency.objectId,
    )!;
    const held = new Set(
      planetLooks(existing)
        .filter((l) => first.slice(0, 3).some((p) => p.objectId === l.objectId))
        .map((l) => l.type),
    );
    // All six types are used once; the system holds three, so the seventh must be one of the other three.
    expect(held.size).toBe(3);
    expect(held.has((seventh as PlanetLook).type)).toBe(false);
  });

  it('takes the least-used type of the universe first, even when its own system already holds it', () => {
    const { subjects, planets } = catalogueWorld();
    const planet = planets.find((p) => p.meaningId === 'history.industrial-revolution')!;
    const system = subjects.find((s) => s.objectId === planet.systemId)!;
    // Eleven earlier planets, all in this system: five types used twice and `barren` once.
    const types: PlanetType[] = [
      'lush',
      'lush',
      'ocean',
      'ocean',
      'frozen',
      'frozen',
      'scorched',
      'scorched',
      'gas',
      'gas',
      'barren',
    ];
    const earlier = types.map((type, index) => ({
      type,
      subject: {
        objectId: id(900 + index),
        kind: 'planet',
        parentId: system.objectId,
        systemId: system.objectId,
        meaningId: 'history.industrial-revolution',
        seed: seedOf(900 + index),
      } satisfies LookSubject,
    }));
    const existing: SceneLook[] = earlier.map(({ type, subject }, index) => ({
      schemaVersion: 'scene-look.v1',
      generatorVersion: 'worldmap.v1',
      objectId: subject.objectId,
      kind: 'planet',
      type,
      rings: false,
      moon: false,
      hueShift: 0,
      variant: index % 2,
      siteCount: 2,
    }));
    const created = assign([system, planet, ...earlier.map((e) => e.subject)], existing).find(
      (l) => l.objectId === planet.objectId,
    ) as PlanetLook;
    // The system holds all six types, so the preference cannot help; usage decides.
    expect(created.type).toBe('barren');
    expect(created.variant).toBe(1);
  });

  it('turns the hue of a repeated type far enough that it is not mistaken for the first', () => {
    const { subjects, planets } = catalogueWorld();
    const looks = planetLooks(assign(subjects, []));
    expect(planets).toHaveLength(looks.length);
    for (const type of PLANET_TYPES) {
      const same = looks.filter((l) => l.type === type);
      for (const [index, a] of same.entries())
        for (const b of same.slice(index + 1))
          expect(hueGap(a.hueShift, b.hueShift), `${type} ${a.variant}/${b.variant}`).toBeGreaterThanOrEqual(15);
    }
    for (const look of looks) {
      expect(Number.isInteger(look.hueShift)).toBe(true);
      expect(look.hueShift).toBeGreaterThanOrEqual(-180);
      expect(look.hueShift).toBeLessThan(180);
    }
  });

  it('draws rings and moons from the planet seed: a gas world always has rings, others only a frozen one by seed', () => {
    const { subjects } = catalogueWorld();
    const looks = planetLooks(assign(subjects, []));
    expect(looks.filter((l) => l.type === 'gas').every((l) => l.rings)).toBe(true);
    expect(looks.filter((l) => l.type !== 'gas' && l.type !== 'frozen').some((l) => l.rings)).toBe(false);
    // The same seed gives the same moon whatever type the planet got.
    const again = planetLooks(assign([...subjects].reverse(), []));
    expect(new Map(again.map((l) => [l.objectId, l.moon]))).toEqual(new Map(looks.map((l) => [l.objectId, l.moon])));
  });

  it('pins the facet order: the plan may only append a facet to a planet, never insert or reorder one', () => {
    const live = new Map(CONCEPTS.filter((c) => c.parent !== null).map((c) => [c.id, c.facets.map((f) => f.id)]));
    for (const [planetId, ordered] of Object.entries(FACET_ORDER))
      expect(
        live.get(planetId)?.slice(0, ordered.length),
        `${planetId}: facets are append-only (D-078). A region's site is its facet's position, so an inserted or reordered facet puts two regions in one cell. Append the new facet at the end of the planet, and the table above with it.`,
      ).toEqual(ordered);
    // A planet the table does not know yet is new, so it has no stored looks to protect; add it to the table.
    expect([...live.keys()].sort(), 'a new planet belongs in the table above').toEqual(Object.keys(FACET_ORDER).sort());
  });

  it('gives a region the position of its facet in the pinned order, and a planet its facets plus spare sites', () => {
    const world = catalogueWorld();
    const looks = assign(world.subjects, []);
    for (const planet of world.planets) {
      const ordered = FACET_ORDER[planet.meaningId]!;
      const look = looks.find((l) => l.objectId === planet.objectId) as PlanetLook;
      expect(look.siteCount).toBe(ordered.length + RESERVED_SITES);
      const sites = world
        .regionsOf(planet)
        .map((r) => [r.meaningId, (looks.find((l) => l.objectId === r.objectId) as RegionLook).site]);
      expect(sites).toEqual(ordered.map((facetId, ordinal) => [facetId, ordinal]));
    }
  });

  it('accepts a facet appended after its planet was drawn, as long as a spare site is left, and moves nothing', () => {
    const world = catalogueWorld();
    // The Seasons planet was drawn when it had three facets; its fourth, `elsewhere`, was appended later.
    const planet = world.planets.find((p) => p.meaningId === 'earth.seasons')!;
    const regions = world.regionsOf(planet);
    expect(regions).toHaveLength(4);
    const earlier = world.subjects.filter((s) => s.kind !== 'region' || !regions.includes(s) || s !== regions[3]);
    const drawn = assign(earlier, []);
    const planetLook = drawn.find((l) => l.objectId === planet.objectId) as PlanetLook;
    const storedAtThreeFacets: SceneLook[] = drawn.map((l) =>
      l === planetLook ? { ...planetLook, siteCount: 3 + RESERVED_SITES } : l,
    );
    const outcome = assignLooks(world.subjects, storedAtThreeFacets);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.created).toEqual([
      expect.objectContaining({ objectId: regions[3]!.objectId, kind: 'region', site: 3 }),
    ]);
    // Nothing else changed: the planet keeps the look it was drawn with, and so does every other place.
    expect(storedAtThreeFacets.find((l) => l.objectId === planet.objectId)).toMatchObject({
      siteCount: 3 + RESERVED_SITES,
    });
  });

  it('skips only a region past the sites its planet was drawn with, and says why', () => {
    const world = catalogueWorld();
    const planet = world.planets.find((p) => p.meaningId === 'earth.seasons')!;
    const regions = world.regionsOf(planet);
    const planetLook = assign(world.subjects, []).find((l) => l.objectId === planet.objectId) as PlanetLook;
    // Drawn when it had two facets and no spare sites (not possible today; the edge is what matters).
    const outcome = assignLooks(
      world.subjects.filter((s) => s.kind !== 'region' || s.parentId === planet.objectId),
      [{ ...planetLook, siteCount: 2 }],
    );
    expect(outcome.skipped).toEqual([
      { objectId: regions[2]!.objectId, reason: 'site_beyond_capacity' },
      { objectId: regions[3]!.objectId, reason: 'site_beyond_capacity' },
    ]);
    // The two inside it still get theirs; the rest of the universe is untouched by the skip.
    expect(outcome.created.flatMap((l) => (l.kind === 'region' ? [l.site] : []))).toEqual([0, 1]);
    expect(outcome.created.some((l) => l.objectId === planet.objectId)).toBe(false);
  });

  it('keeps a region on its site when another region forms, in any order', () => {
    const world = catalogueWorld();
    const planet = world.planets.find((p) => p.meaningId === 'earth.seasons')!;
    const regions = world.regionsOf(planet);
    const [tilt] = regions;
    const withoutRegions = world.subjects.filter((s) => s.kind !== 'region');
    // One region at a time, each in a later pass: the first one's site never moves.
    let subjects = [...withoutRegions, tilt!];
    let known = assign(subjects, []);
    const tiltSite = (known.find((l) => l.objectId === tilt!.objectId) as RegionLook).site;
    for (const region of regions.slice(1)) {
      subjects = [...subjects, region];
      known = [...known, ...assign(subjects, known)];
      expect((known.find((l) => l.objectId === tilt!.objectId) as RegionLook).site).toBe(tiltSite);
    }
    // The last facet forming first gives every region the same site as the forward order did.
    let reverseSubjects = [...withoutRegions];
    let reverse = assign(reverseSubjects, []);
    for (const region of [...regions].reverse()) {
      reverseSubjects = [...reverseSubjects, region];
      reverse = [...reverse, ...assign(reverseSubjects, reverse)];
    }
    for (const region of regions)
      expect((reverse.find((l) => l.objectId === region.objectId) as RegionLook).site).toBe(
        (known.find((l) => l.objectId === region.objectId) as RegionLook).site,
      );
  });

  it('gives the same looks whatever order the subjects are listed in', () => {
    const { subjects } = catalogueWorld();
    const forward = assign(subjects, []);
    expect(assign([...subjects].reverse(), [])).toEqual(forward);
    expect(assign(subjects, [])).toEqual(forward);
  });

  it('gives a batch the same looks as the same planets arriving one at a time in creation order', () => {
    const { subjects, planets } = catalogueWorld();
    const arriving = planets.slice(0, 9);
    const batch = assign(onlyPlanets(subjects, arriving), []);
    let one: SceneLook[] = [];
    for (const [index] of arriving.entries())
      one = [...one, ...assign(onlyPlanets(subjects, arriving.slice(0, index + 1)), one)];
    const typeOf = (looks: readonly SceneLook[]) =>
      new Map(planetLooks(looks).map((l) => [l.objectId, [l.type, l.variant, l.hueShift]]));
    expect(typeOf(batch)).toEqual(typeOf(one));
    // Listing the batch the other way round changes nothing: creation order, not list order, decides.
    expect(typeOf(assign([...onlyPlanets(subjects, arriving)].reverse(), []))).toEqual(typeOf(one));
  });

  it('never changes or repeats a look it already gave, and gives nothing when every place has one', () => {
    const { subjects } = catalogueWorld();
    const all = assign(subjects, []);
    expect(assign(subjects, all)).toEqual([]);
    const withoutLast = all.slice(0, -3);
    const rest = assign(subjects, withoutLast);
    expect(rest).toEqual(all.slice(-3));
  });

  it('keeps earlier planets as they are when later ones arrive in a later pass, in either order', () => {
    const { subjects, planets } = catalogueWorld();
    const subset = (take: readonly LookSubject[]) => onlyPlanets(subjects, take);
    const early = planets.slice(0, 8);
    const late = planets.slice(8);
    const base = assign(subset(early), []);
    const after = [...base, ...assign(subset([...early, ...late]), base)];
    for (const look of base) expect(after.find((l) => l.objectId === look.objectId)).toEqual(look);
    // Arriving in the opposite order is a different universe history, but each history is stable on its own.
    const reversed = [...planets].reverse();
    const first = assign(subset(reversed.slice(0, 8)), []);
    const second = [...first, ...assign(subset(reversed), first)];
    for (const look of first) expect(second.find((l) => l.objectId === look.objectId)).toEqual(look);
  });
});

describe('the look rule refuses what the plan cannot explain', () => {
  const world = catalogueWorld();
  const looks = assign(world.subjects, []);
  const refused = (subjects: readonly LookSubject[], existing: readonly SceneLook[] = []) =>
    expect(() => assign(subjects, existing)).toThrow(LookRefused);

  it('a system or planet the plan does not hold', () => {
    const system = world.subjects.find((s) => s.kind === 'system')!;
    refused([{ ...system, meaningId: 'astronomy' }]);
    const planet = world.planets[0]!;
    refused([world.subjects.find((s) => s.objectId === planet.systemId)!, { ...planet, meaningId: 'earth.unknown' }]);
  });

  it('a region whose facet is not on its planet, or whose planet has no look', () => {
    const planet = world.planets.find((p) => p.meaningId === 'earth.seasons')!;
    const system = world.subjects.find((s) => s.objectId === planet.systemId)!;
    const region = world.regionsOf(planet)[0]!;
    const systemLook = looks.find((l) => l.objectId === system.objectId)!;
    // A region whose parent is a system, not a planet, has no planet to take a site from.
    refused([system, planet, { ...region, parentId: system.objectId }], [systemLook]);
    const planetLook = looks.find((l) => l.objectId === planet.objectId)!;
    refused([system, planet, { ...region, meaningId: 'earth.tides.coasts' }], [systemLook, planetLook]);
  });

  it('a look whose object is no longer stored', () => {
    refused([], [looks[0]!]);
  });
});
