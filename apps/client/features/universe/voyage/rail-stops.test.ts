import type { UniverseView } from '../universe-layout';
import { goToStop, railOf, type OuterSwitch } from './rail-stops';

const OWN = { otherUniverses: true, ground: true };
const FRIEND = { otherUniverses: false, ground: false };
const names = (at: Parameters<typeof railOf>[0], reach = OWN) => railOf(at, reach).map((stop) => stop.name);

describe('the stops the rail lists', () => {
  it('lists other universes and the whole universe at your universe, the universe current', () => {
    expect(names('universe')).toEqual(['Other universes', 'Universe']);
    expect(railOf('universe', OWN).find((stop) => stop.current)?.stop).toBe('universe');
  });

  it('lists the star once you are at it, and the planet and the ground once you are at a planet you may land on', () => {
    expect(names('star')).toEqual(['Other universes', 'Universe', 'Star']);
    expect(names('planet')).toEqual(['Other universes', 'Universe', 'Star', 'Planet', 'Ground']);
    expect(names('ground')).toEqual(['Other universes', 'Universe', 'Star', 'Planet', 'Ground']);
    expect(
      railOf('ground', OWN)
        .filter((stop) => stop.current)
        .map((stop) => stop.stop),
    ).toEqual(['ground']);
  });

  it('never lists other universes in a friend’s Universe, nor the ground of a friend’s planet', () => {
    expect(names('universe', FRIEND)).toEqual(['Universe']);
    expect(names('planet', FRIEND)).toEqual(['Universe', 'Star', 'Planet']);
  });

  it('marks other universes current past your rim', () => {
    expect(railOf('outer', OWN).map((stop) => [stop.name, stop.current])).toEqual([
      ['Other universes', true],
      ['Universe', false],
    ]);
  });
});

describe('going to a stop', () => {
  const system = { objectId: 'sys' } as never;
  const planet = { objectId: 'pla', parentId: 'sys' } as never;
  const region = { objectId: 'reg' } as never;
  const views = {
    universe: { kind: 'universe' } as UniverseView,
    star: { kind: 'system', system } as UniverseView,
    planet: { kind: 'planet', planet, landed: false } as UniverseView,
    ground: { kind: 'planet', planet, landed: true } as UniverseView,
    region: { kind: 'planet', planet, landed: true, selectedRegion: region } as UniverseView,
  };
  const sessionOf = () => ({ focus: jest.fn(() => true), land: jest.fn(() => true), up: jest.fn(() => true) });
  const outerOf = (): OuterSwitch & { enter: jest.Mock; leave: jest.Mock } => ({ enter: jest.fn(), leave: jest.fn() });

  it('does nothing for the stop you are at', () => {
    const session = sessionOf();
    expect(goToStop(session, views.star, 'star', 'star', null)).toBe(false);
    expect(session.up).not.toHaveBeenCalled();
  });

  it('climbs to the whole universe a level at a time, so Back comes down the same way', () => {
    for (const [view, at, levels] of [
      [views.star, 'star', 1],
      [views.planet, 'planet', 2],
      [views.ground, 'ground', 2],
      [views.region, 'ground', 3],
    ] as const) {
      const session = sessionOf();
      expect(goToStop(session, view, at, 'universe', null)).toBe(true);
      expect(session.up).toHaveBeenCalledTimes(levels);
    }
  });

  it('goes past the rim from anywhere on your own map, and back to the universe from there', () => {
    const session = sessionOf();
    const outer = outerOf();
    expect(goToStop(session, views.planet, 'planet', 'outer', outer)).toBe(true);
    expect(session.up).toHaveBeenCalledTimes(2);
    expect(outer.enter).toHaveBeenCalledTimes(1);
    expect(goToStop(sessionOf(), views.universe, 'outer', 'universe', outer)).toBe(true);
    expect(outer.leave).toHaveBeenCalledTimes(1);
    expect(goToStop(sessionOf(), views.universe, 'universe', 'outer', null)).toBe(false);
  });

  it('goes to the star or the planet you are in, and lands for the ground', () => {
    const session = sessionOf();
    goToStop(session, views.ground, 'ground', 'star', null);
    expect(session.focus).toHaveBeenLastCalledWith('sys');
    goToStop(session, views.region, 'ground', 'planet', null);
    expect(session.focus).toHaveBeenLastCalledWith('pla');
    goToStop(session, views.planet, 'planet', 'ground', null);
    expect(session.land).toHaveBeenCalledTimes(1);
  });
});
