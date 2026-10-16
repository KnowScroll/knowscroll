import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONDITION_LABEL, deriveSky, starCaption, type StarView, type UniverseSky } from '../../src/cosmos/starView.ts';
import { atlasOf, chronicle, ids, planet, region, relation, room, sighting, twoStarSky } from './skyFixture.ts';

const QUIET_TEXT = 'Quiet: nothing inside it has unfolded yet. It holds its possibilities as they are.';

function star(sky: UniverseSky, placeId: string): StarView {
  const found = sky.stars.find(item => item.placeId === placeId);
  if (!found) throw new Error(`no star ${placeId}`);
  return found;
}

const foundation = (holdsUp: string[]) => ({
  holdsUp,
  relations: [{ kind: 'explains' as const, from: 'Gravity', to: 'Orbits', claim: { text: 'Gravity keeps bodies on their orbits.' }, bridge: null }],
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveSky: stars and their worlds (ADR-0051 §1)', () => {
  it('draws one star per live top-level place, with facet worlds, question worlds and possibilities in its system', () => {
    const sky = deriveSky(twoStarSky());
    expect(sky.stars.map(item => item.name)).toEqual(['Gravity', 'Light']);

    const gravity = star(sky, ids.gravity);
    expect(gravity.worlds.map(world => world.kind === 'facet' ? world.name : world.question)).toEqual([
      'Orbits',
      "Kepler's laws",
      'Does gravity shape the paths we see?',
      'Why are orbits ellipses?',
    ]);
    // Regions, rooms and sightings never become stars of their own.
    expect(sky.stars.some(item => [ids.orbits, ids.kepler, ids.starFormation, ids.tides].includes(item.placeId))).toBe(false);
  });

  it('a region inside a region is a depth-2 facet world of the same star, related through its parent', () => {
    const gravity = star(deriveSky(twoStarSky()), ids.gravity);
    const [orbits, kepler] = gravity.worlds;
    expect(orbits).toMatchObject({ kind: 'facet', placeId: ids.orbits, depth: 1, parentName: 'Gravity', relation: 'A narrower part of Gravity. It formed from what you kept, asked or followed there.' });
    expect(kepler).toMatchObject({
      kind: 'facet',
      placeId: ids.kepler,
      depth: 2,
      parentName: 'Orbits',
      relation: "A narrower part of Orbits, inside Gravity. It formed from what you kept, asked or followed there.",
    });
  });

  it('a room on a facet world is a question world of the star, read from the place the room is on', () => {
    const gravity = star(deriveSky(twoStarSky()), ids.gravity);
    const questions = gravity.worlds.filter(world => world.kind === 'question');
    expect(questions).toEqual([
      expect.objectContaining({ id: `room:${ids.roomGravity}`, roomId: ids.roomGravity, placeId: ids.gravity, placeName: 'Gravity', state: 'arguing' }),
      expect.objectContaining({ id: `room:${ids.roomOrbits}`, roomId: ids.roomOrbits, placeId: ids.orbits, placeName: 'Orbits', state: 'opened' }),
    ]);
    // Several positions are shown together; none is marked as the answer.
    const argued = questions[0]!;
    if (argued.kind !== 'question') throw new Error('expected a question world');
    expect(argued.positions.map(position => position.label)).toEqual(['Your reading', 'A doubt']);
    expect(argued.relation).toContain('neither is marked as the answer');
    expect(star(deriveSky(twoStarSky()), ids.light).worlds).toEqual([]);
  });

  it('a sighting at the edge of a world is still a possibility of the root star, phrased from that world', () => {
    const sky = deriveSky(twoStarSky());
    expect(star(sky, ids.gravity).possibilities).toEqual([
      expect.objectContaining({ placeId: ids.starFormation, fromName: 'Gravity', relationKind: 'explains', phrase: 'explains part of Gravity', claim: 'Gravity gathers gas into stars.' }),
      expect.objectContaining({ placeId: ids.tides, fromName: 'Orbits', relationKind: 'analogous_in', phrase: 'another way of seeing Orbits', claim: null }),
    ]);
    expect(star(sky, ids.light).possibilities).toEqual([]);
  });

  it('places under a missing parent or under no star belong to no system', () => {
    const sky = deriveSky(atlasOf([
      planet(ids.gravity, 'Gravity'),
      // A region whose parent is no longer live arrives top-level; a dangling link is refused too.
      planet(ids.orphan, 'Lost region', { kind: 'region' }),
      region(ids.kepler, ids.missingParent, 'Dangling region'),
      sighting(ids.tides, ids.missingParent, 'Tides', 'explains'),
    ]));
    expect(sky.stars).toHaveLength(1);
    expect(sky.stars[0]!.worlds).toEqual([]);
    expect(sky.stars[0]!.possibilities).toEqual([]);
    expect(sky.stars[0]!.condition).toBe('quiet');
  });
});

describe('deriveSky: conditions, their precedence and their reasons (ADR-0051 §2)', () => {
  it('quiet: no world, no question, no connection; its possibilities are listed and it never claims more', () => {
    const music = star(deriveSky(atlasOf([
      planet(ids.music, 'Music'),
      sighting(ids.tides, ids.music, 'Rhythm', 'compares_mechanism'),
    ])), ids.music);
    expect(music.condition).toBe('quiet');
    expect(music.tense).toBe(false);
    expect(music.luminous).toBe(false);
    expect(music.reasons).toEqual([
      { kind: 'possibilities', text: 'One possibility at its edge, not met yet: Rhythm.' },
      { kind: 'quiet', text: QUIET_TEXT },
    ]);
    expect(starCaption(music)).toBe('1 possibility');
    expect(starCaption(star(deriveSky(atlasOf([planet(ids.music, 'Music')])), ids.music))).toBe(CONDITION_LABEL.quiet);
  });

  it('stirring: one facet world, one question world, or one connection is enough', () => {
    const withWorld = star(deriveSky(atlasOf([planet(ids.gravity, 'Gravity'), region(ids.orbits, ids.gravity, 'Orbits')])), ids.gravity);
    expect(withWorld.condition).toBe('stirring');
    expect(withWorld.reasons).toEqual([{ kind: 'world', text: 'Orbits formed inside Gravity.' }]);

    const withQuestion = star(deriveSky(atlasOf([planet(ids.gravity, 'Gravity', { rooms: [room(ids.roomGravity, 'Why do apples fall?')] })])), ids.gravity);
    expect(withQuestion.condition).toBe('stirring');
    expect(withQuestion.tense).toBe(false);
    expect(withQuestion.reasons).toEqual([{ kind: 'question', text: 'You carried a question here: “Why do apples fall?”' }]);

    const withLine = deriveSky(atlasOf([planet(ids.gravity, 'Gravity'), planet(ids.light, 'Light')], [relation(ids.light, ids.gravity, 'prerequisite_for', { claim: 'Light comes first.' })]));
    expect(star(withLine, ids.gravity).condition).toBe('stirring');
    expect(star(withLine, ids.light).condition).toBe('stirring');
    expect(star(withLine, ids.gravity).reasons).toEqual([{ kind: 'connection', text: 'Light comes before Gravity.' }]);
  });

  it('tense: an arguing room, or a contradicts relation touching the star or one of its worlds', () => {
    const sky = deriveSky(twoStarSky());
    const gravity = star(sky, ids.gravity);
    expect(gravity.condition).toBe('tense');
    expect(gravity.reasons[0]).toEqual({ kind: 'tension', text: 'Two readings of “Does gravity shape the paths we see?” pull against each other.' });

    const contradicted = deriveSky(atlasOf(
      [planet(ids.gravity, 'Gravity'), region(ids.orbits, ids.gravity, 'Orbits'), planet(ids.light, 'Light'), region(ids.optics, ids.light, 'Optics')],
      [relation(ids.orbits, ids.optics, 'contradicts', { claim: 'The two readings disagree.' })],
    ));
    for (const id of [ids.gravity, ids.light]) {
      expect(star(contradicted, id).condition).toBe('tense');
      expect(star(contradicted, id).reasons).toContainEqual({ kind: 'tension', text: 'Orbits is in tension with Optics.' });
    }
    expect(contradicted.constellations).toEqual([expect.objectContaining({ tension: true, kinds: ['contradicts'] })]);
  });

  it('luminous takes precedence over tense, and tension stays listed as a reason', () => {
    const sky = deriveSky(atlasOf(
      [
        planet(ids.gravity, 'Gravity', { foundation: foundation([ids.orbits, ids.light]) }),
        region(ids.orbits, ids.gravity, 'Orbits'),
        planet(ids.light, 'Light'),
      ],
      [relation(ids.gravity, ids.light, 'contradicts', { claim: 'They pull apart.' })],
    ));
    const gravity = star(sky, ids.gravity);
    expect(gravity.condition).toBe('luminous');
    expect(gravity.tense).toBe(true);
    expect(gravity.luminous).toBe(true);
    expect(gravity.holdsUp).toEqual([{ placeId: ids.orbits, name: 'Orbits' }, { placeId: ids.light, name: 'Light' }]);
    expect(gravity.reasons.map(reason => reason.kind)).toEqual(['luminous', 'tension', 'world']);
    expect(gravity.reasons[0]!.text).toBe('Its light reaches Orbits and Light: sourced connections say Gravity holds them up.');
    expect(gravity.reasons[1]!.text).toBe('Gravity is in tension with Light.');
    expect(starCaption(gravity)).toBe('1 world');
    expect(star(sky, ids.light).condition).toBe('tense');
  });

  it('a foundation whose held places are not on the map still says only what is recorded', () => {
    const gravity = star(deriveSky(atlasOf([planet(ids.gravity, 'Gravity', { foundation: foundation([ids.missingParent]) })])), ids.gravity);
    expect(gravity.condition).toBe('luminous');
    expect(gravity.holdsUp).toEqual([]);
    expect(gravity.reasons).toEqual([{ kind: 'luminous', text: 'Sourced connections say Gravity holds other places up.' }]);
  });

  it('lists every reason in a fixed order, as words about real things', () => {
    const gravity = star(deriveSky(twoStarSky()), ids.gravity);
    expect(gravity.reasons).toEqual([
      { kind: 'tension', text: 'Two readings of “Does gravity shape the paths we see?” pull against each other.' },
      { kind: 'world', text: 'Orbits formed inside Gravity.' },
      { kind: 'world', text: "Kepler's laws formed inside Orbits." },
      { kind: 'question', text: 'You carried a question here: “Does gravity shape the paths we see?”' },
      { kind: 'question', text: 'You carried a question here: “Why are orbits ellipses?”' },
      { kind: 'connection', text: 'Gravity explains Orbits.' },
      { kind: 'connection', text: 'Orbits applies to Light.' },
      { kind: 'possibilities', text: '2 possibilities at its edge, not met yet.' },
    ]);
    expect(starCaption(gravity)).toBe('2 worlds · 2 questions · 2 possibilities');
    // Never a level, percentage, streak or score.
    for (const reason of gravity.reasons) expect(reason.text).not.toMatch(/%|level|streak|score|\bdays?\b|idle|missed/i);
  });

  it('orders stars for layout by how developed they are, never by attention', () => {
    const sky = deriveSky(atlasOf([
      planet(ids.music, 'Music', { formedAt: '2026-09-01T12:00:00.000Z' }),
      planet(ids.light, 'Light', { formedAt: '2026-09-02T12:00:00.000Z' }),
      region(ids.optics, ids.light, 'Optics'),
      planet(ids.gravity, 'Gravity', { foundation: foundation([ids.optics]), formedAt: '2026-09-03T12:00:00.000Z' }),
    ]));
    expect(sky.stars.map(item => [item.name, item.condition])).toEqual([
      ['Gravity', 'luminous'],
      ['Light', 'stirring'],
      ['Music', 'quiet'],
    ]);
  });
});

describe('deriveSky: quiet is not dormant (ADR-0051 §3)', () => {
  it('a dormant star with no worlds is quiet, exactly like one with fresh attention', () => {
    const dormant = star(deriveSky(atlasOf([planet(ids.music, 'Music', { attention: { state: 'dormant', episodes: 9, daysActive: 5 } })])), ids.music);
    expect(dormant.condition).toBe('quiet');
    expect(dormant.reasons).toEqual([{ kind: 'quiet', text: QUIET_TEXT }]);
  });

  it('a dormant star with a world is not dimmed: it is stirring like any other', () => {
    const sky = deriveSky(atlasOf([
      planet(ids.music, 'Music', { attention: { state: 'dormant', episodes: 9, daysActive: 5 } }),
      region(ids.tides, ids.music, 'Rhythm', { attention: { state: 'dormant', episodes: 3, daysActive: 2 } }),
    ]));
    const music = star(sky, ids.music);
    expect(music.condition).toBe('stirring');
    expect(music.reasons).toEqual([{ kind: 'world', text: 'Rhythm formed inside Music.' }]);
    expect(music.reasons.some(reason => reason.kind === 'quiet')).toBe(false);
  });

  it('the whole sky is identical whatever the attention states, view counts or the clock say', () => {
    const base = twoStarSky();
    const reshaped = atlasOf(
      base.places.map(place => place.kind === 'sighting'
        ? place
        : { ...place, attention: place.placeId === ids.gravity ? null : { state: 'dormant' as const, episodes: 40, daysActive: 30 } }),
      base.relations,
      base.chronicle,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const now = deriveSky(base);
    vi.setSystemTime(new Date('2027-12-31T00:00:00.000Z'));
    expect(deriveSky(base)).toEqual(now);
    expect(deriveSky(reshaped)).toEqual(now);

    // Seen and unseen counts move only whether there is more to read, never a condition or a reason.
    const countsChanged = atlasOf(base.places.map(place => ({ ...place, scrolls: { total: 40, seen: 40 } })), base.relations, base.chronicle);
    const counted = deriveSky(countsChanged);
    expect(counted.stars.map(item => [item.condition, item.reasons, item.worlds.length])).toEqual(now.stars.map(item => [item.condition, item.reasons, item.worlds.length]));
  });
});

describe('deriveSky: connections and constellations', () => {
  it('a claim and a bridge for the same connection are one line carrying the claim, in either order', () => {
    const claim = relation(ids.gravity, ids.orbits, 'explains', { claim: 'Gravity keeps bodies on their orbits.' });
    const bridge = relation(ids.gravity, ids.orbits, 'explains', { bridge: 'Both are about falling.' });
    for (const relations of [[claim, bridge], [bridge, claim]]) {
      const gravity = star(deriveSky(atlasOf([planet(ids.gravity, 'Gravity'), region(ids.orbits, ids.gravity, 'Orbits')], relations)), ids.gravity);
      expect(gravity.connections).toEqual([
        expect.objectContaining({ fromPlaceId: ids.gravity, toPlaceId: ids.orbits, kind: 'explains', support: 'Gravity keeps bodies on their orbits.', otherStarId: null, tension: false }),
      ]);
      expect(gravity.reasons.filter(reason => reason.kind === 'connection')).toHaveLength(1);
    }
    // A bridge alone still carries its mechanism; a different kind is a different line.
    const bridged = star(deriveSky(atlasOf(
      [planet(ids.gravity, 'Gravity'), region(ids.orbits, ids.gravity, 'Orbits')],
      [bridge, relation(ids.gravity, ids.orbits, 'applies_to', { claim: 'Gravity applies to orbits.' })],
    )), ids.gravity);
    expect(bridged.connections.map(item => [item.kind, item.support])).toEqual([
      ['explains', 'Both are about falling.'],
      ['applies_to', 'Gravity applies to orbits.'],
    ]);
  });

  it('constellations join two different stars only; lines inside one system stay inside it', () => {
    const sky = deriveSky(atlasOf(
      [planet(ids.gravity, 'Gravity'), region(ids.orbits, ids.gravity, 'Orbits'), planet(ids.light, 'Light'), region(ids.optics, ids.light, 'Optics'), planet(ids.orphan, 'Lost region', { kind: 'region' })],
      [
        relation(ids.gravity, ids.orbits, 'explains', { claim: 'Inside one system.' }),
        relation(ids.optics, ids.orbits, 'analogous_in', { claim: 'Across systems.' }),
        relation(ids.light, ids.gravity, 'applies_to', { bridge: 'Across systems again.' }),
        relation(ids.orphan, ids.gravity, 'explains', { claim: 'From nowhere.' }),
      ],
    ));
    expect(sky.constellations).toEqual([{
      key: `${ids.gravity}:${ids.light}`,
      fromStarId: ids.gravity,
      toStarId: ids.light,
      kinds: ['analogous_in', 'applies_to'],
      tension: false,
      sentence: 'Optics works like Orbits.',
    }]);
    const gravity = star(sky, ids.gravity);
    expect(gravity.connections.map(item => [item.sentence, item.otherStarId])).toEqual([
      ['Gravity explains Orbits.', null],
      ['Optics works like Orbits.', ids.light],
      ['Light applies to Gravity.', ids.light],
      ['Lost region explains Gravity.', null],
    ]);
  });
});

describe('deriveSky: transformations come only from recorded changes (ADR-0051 §4)', () => {
  it('maps each recorded kind to its drawing, adds one question world per room, newest first', () => {
    const sky = deriveSky(atlasOf(
      [
        planet(ids.gravity, 'Gravity', { foundation: foundation([ids.orbits]), rooms: [room(ids.roomGravity, 'Why do apples fall?', 'opened', '2026-09-27T12:00:00.000Z')] }),
        region(ids.orbits, ids.gravity, 'Orbits'),
        sighting(ids.tides, ids.gravity, 'Tides', 'explains'),
      ],
      [],
      [
        chronicle(1, ids.gravity, null, 'place_formed', '2026-09-20T12:00:00.000Z', 'Gravity became a place.'),
        chronicle(2, ids.orbits, ids.gravity, 'place_formed', '2026-09-21T12:00:00.000Z', 'Orbits formed inside Gravity.'),
        chronicle(3, ids.tides, ids.gravity, 'sighting_appeared', '2026-09-22T12:00:00.000Z', 'Tides appeared at the edge of Gravity.'),
        chronicle(4, ids.gravity, null, 'foundation_recognised', '2026-09-23T12:00:00.000Z', 'Gravity holds up Orbits.'),
        chronicle(5, ids.released, ids.gravity, 'place_released', '2026-09-24T12:00:00.000Z', 'A region was released.'),
        chronicle(6, ids.released, ids.gravity, 'place_rejected', '2026-09-25T12:00:00.000Z', 'You set a region aside.'),
        chronicle(7, ids.gravity, null, 'foundation_withdrawn', '2026-09-26T12:00:00.000Z', 'Gravity no longer holds up Tides.'),
      ],
    ));
    expect(sky.transformations.map(item => [item.id, item.kind, item.starId])).toEqual([
      [`room:${ids.roomGravity}`, 'question_world', ids.gravity],
      [ids.delta(7), 'quiet_change', ids.gravity],
      [ids.delta(6), 'quiet_change', ids.gravity],
      [ids.delta(5), 'quiet_change', ids.gravity],
      [ids.delta(4), 'luminous', ids.gravity],
      [ids.delta(3), 'possibility', ids.gravity],
      [ids.delta(2), 'world_formed', ids.gravity],
      [ids.delta(1), 'star_ignited', ids.gravity],
    ]);
    expect(sky.transformations[0]).toMatchObject({ placeId: ids.gravity, line: 'A question world formed around “Why do apples fall?”.', at: '2026-09-27T12:00:00.000Z' });
    expect(sky.transformations[4]!.line).toBe('Gravity holds up Orbits.');
    // A change to a place that is gone but whose parent is a live star still belongs to that star.
    expect(star(sky, ids.gravity).chronicle.map(entry => entry.deltaId)).toEqual([1, 2, 3, 4, 5, 6, 7].map(ids.delta));
    expect(sky.looseChronicle).toEqual([]);
  });

  it('a room on a facet world forms a question world on the root star', () => {
    const transformations = deriveSky(twoStarSky()).transformations;
    expect(transformations.filter(item => item.kind === 'question_world').map(item => [item.id, item.starId, item.placeId])).toEqual([
      [`room:${ids.roomOrbits}`, ids.gravity, ids.orbits],
      [`room:${ids.roomGravity}`, ids.gravity, ids.gravity],
    ]);
  });

  it('a change that belongs to no live star is loose chronicle, never placed on a star', () => {
    const sky = deriveSky(atlasOf(
      [planet(ids.gravity, 'Gravity')],
      [],
      [
        chronicle(1, ids.released, null, 'place_released', '2026-09-24T12:00:00.000Z', 'Music was released.'),
        chronicle(2, ids.orphan, ids.missingParent, 'sighting_retired', '2026-09-25T12:00:00.000Z', 'A sighting was retired.'),
        chronicle(3, ids.released, null, 'place_formed', '2026-09-20T12:00:00.000Z', 'Music became a place.'),
      ],
    ));
    expect(sky.looseChronicle.map(entry => entry.deltaId)).toEqual([ids.delta(1), ids.delta(2), ids.delta(3)]);
    expect(sky.transformations.map(item => [item.id, item.kind, item.starId])).toEqual([
      [ids.delta(2), 'quiet_change', null],
      [ids.delta(1), 'quiet_change', null],
      [ids.delta(3), 'star_ignited', null],
    ]);
    expect(star(sky, ids.gravity).chronicle).toEqual([]);
  });

  it('never invents a change: an Atlas with no chronicle and no rooms has none', () => {
    const sky = deriveSky(atlasOf([planet(ids.gravity, 'Gravity', { scrolls: { total: 90, seen: 90 } }), region(ids.orbits, ids.gravity, 'Orbits')]));
    expect(sky.transformations).toEqual([]);
  });
});
