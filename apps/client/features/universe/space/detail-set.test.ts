import {
  ANCHOR_CAP,
  chooseDetail,
  DETAIL_HOLD,
  DETAIL_MAX,
  DETAIL_RADIUS,
  drawsEverything,
  fromMiddle,
  onScreen,
  sameSet,
  type SystemPlaces,
} from './detail-set';

/** `count` systems on a square grid `spacing` scene units apart, centred on the origin. */
function grid(count: number, spacing = 9.6): SystemPlaces {
  const side = Math.ceil(Math.sqrt(count));
  const ids: string[] = [];
  const x: number[] = [];
  const z: number[] = [];
  for (let at = 0; at < count; at++) {
    ids.push(`s${at.toString().padStart(5, '0')}`);
    x.push(((at % side) - side / 2) * spacing);
    z.push((Math.floor(at / side) - side / 2) * spacing);
  }
  return { ids, x, z };
}
const centre = { x: 0, z: 0 };
const nobody = new Set<string>();

describe('which systems are drawn in full', () => {
  it('draws every system of a small map, wherever the camera looks', () => {
    for (const count of [0, 1, 6, DETAIL_MAX]) {
      const places = grid(count);
      expect(drawsEverything(count)).toBe(true);
      const chosen = chooseDetail({ places, target: { x: 900, z: -900 }, pinned: nobody, previous: nobody });
      expect([...chosen].sort()).toEqual([...places.ids].sort());
    }
    expect(drawsEverything(DETAIL_MAX + 1)).toBe(false);
  });

  it('bounds a large map to the nearest few inside the radius, never more than the maximum', () => {
    const places = grid(5000);
    const chosen = chooseDetail({ places, target: centre, pinned: nobody, previous: nobody });
    expect(chosen.size).toBeLessThanOrEqual(DETAIL_MAX);
    expect(chosen.size).toBe(DETAIL_MAX);
    const at = new Map(places.ids.map((id, n) => [id, n]));
    for (const id of chosen)
      expect(Math.hypot(places.x[at.get(id)!]!, places.z[at.get(id)!]!)).toBeLessThanOrEqual(DETAIL_RADIUS);
    // The nearest are chosen: no system left out is nearer than one taken.
    const reach = Math.max(...[...chosen].map((id) => Math.hypot(places.x[at.get(id)!]!, places.z[at.get(id)!]!)));
    for (const [id, n] of at)
      if (!chosen.has(id)) expect(Math.hypot(places.x[n]!, places.z[n]!)).toBeGreaterThanOrEqual(reach - 1e-6);
  });

  it('chooses nothing far from every system, and only what is inside the radius', () => {
    const places = grid(500);
    expect(chooseDetail({ places, target: { x: 5000, z: 5000 }, pinned: nobody, previous: nobody }).size).toBe(0);
    const sparse = chooseDetail({ places, target: centre, pinned: nobody, previous: nobody });
    expect(sparse.size).toBeGreaterThan(0);
  });

  it('keeps the pinned systems however far they are, and counts them within the maximum', () => {
    const places = grid(500);
    const farId = places.ids.at(-1)!;
    const chosen = chooseDetail({ places, target: centre, pinned: new Set([farId]), previous: nobody });
    expect(chosen.has(farId)).toBe(true);
    expect(chosen.size).toBe(DETAIL_MAX);
  });

  it('is the same set for the same input, in whatever order the systems are listed', () => {
    const places = grid(400);
    const first = chooseDetail({ places, target: { x: 7, z: -3 }, pinned: nobody, previous: nobody });
    const reversed: SystemPlaces = {
      ids: [...places.ids].reverse(),
      x: [...(places.x as number[])].reverse(),
      z: [...(places.z as number[])].reverse(),
    };
    const second = chooseDetail({ places: reversed, target: { x: 7, z: -3 }, pinned: nobody, previous: nobody });
    expect(sameSet(first, second)).toBe(true);
  });

  it('holds a system at the edge of the radius while the camera breathes, and lets it go once it is clearly beyond', () => {
    // A single row of systems along x, so the edge is exactly at DETAIL_RADIUS.
    const count = 60;
    const places: SystemPlaces = {
      ids: Array.from({ length: count }, (_, n) => `r${n.toString().padStart(3, '0')}`),
      x: Array.from({ length: count }, (_, n) => n * 3),
      z: Array.from({ length: count }, () => 0),
    };
    const at = (target: number, previous: ReadonlySet<string>) =>
      chooseDetail({ places, target: { x: target, z: 0 }, pinned: nobody, previous });
    const first = at(0, nobody);
    // r020 is at x = 60: exactly on the radius, so it came in.
    expect(first.has('r020')).toBe(true);
    // The camera wanders back by a unit: it would stay out as a newcomer, but is held in.
    const wandered = at(-1, first);
    expect(wandered.has('r020')).toBe(true);
    // As a newcomer it is out.
    expect(at(-1, nobody).has('r020')).toBe(false);
    // Far enough beyond DETAIL_HOLD times the radius, it goes.
    const gone = at(-(DETAIL_RADIUS * DETAIL_HOLD - 60 + 2), first);
    expect(gone.has('r020')).toBe(false);
  });

  it('does not flicker as the camera moves a little: a pan of a unit changes at most a few members', () => {
    const places = grid(5000);
    let previous: ReadonlySet<string> = chooseDetail({ places, target: centre, pinned: nobody, previous: nobody });
    let changes = 0;
    for (let step = 1; step <= 40; step++) {
      const next = chooseDetail({ places, target: { x: step * 0.5, z: 0 }, pinned: nobody, previous });
      for (const id of next) if (!previous.has(id)) changes += 1;
      previous = next;
    }
    // 40 half-unit steps cover 20 units, about two grid columns: a few new systems per column, not 24 per step.
    expect(changes).toBeLessThan(60);
  });

  it('scans thousands of systems quickly enough to run when the camera moves', () => {
    const places = grid(50_000);
    const started = performance.now();
    for (let run = 0; run < 10; run++)
      chooseDetail({ places, target: { x: run * 3, z: 0 }, pinned: nobody, previous: nobody });
    expect((performance.now() - started) / 10).toBeLessThan(25);
  });
});

describe('the screen an anchor must be on', () => {
  it('keeps what is on the screen and a margin beyond it, and drops the rest', () => {
    expect(onScreen({ x: 0, y: 0 })).toBe(true);
    expect(onScreen({ x: 1, y: -1 })).toBe(true);
    expect(onScreen({ x: 1.1, y: 0 })).toBe(true);
    expect(onScreen({ x: 1.2, y: 0 })).toBe(false);
    expect(onScreen({ x: 0, y: -1.5 })).toBe(false);
  });

  it('ranks by distance from the middle', () => {
    expect(fromMiddle({ x: 0.5, y: 0 })).toBeLessThan(fromMiddle({ x: 0.5, y: 0.5 }));
    expect(ANCHOR_CAP).toBe(160);
  });
});
