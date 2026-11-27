import { groundHome, NOWHERE, REATTACH_DISTANCE, REST_SPEED, standsOf, type StandsInput } from './ground-home';
import { GROUND_SIZE } from './ship-ground';

const bounds = { left: 26, right: 364, top: 150, bottom: 640 };
const spot = { x: 195, y: 570 };
const region = (id: string, x: number, y: number, visible = true) => ({ id, x, y, radiusPx: 0, visible });
const place = (anchors: ReturnType<typeof region>[], regionId: string | null, parked = false) =>
  groundHome({ anchors, regionId, spot, avoid: [], bounds, parked });

describe('where the ship stands on the ground', () => {
  it('stands upright on the region the camera came down over, fins on its point, while that is on screen', () => {
    const { home, parked } = place([region('r', 195, 380)], 'r');
    expect(parked).toBe(false);
    expect(home.x).toBe(195);
    expect(home.y).toBeLessThan(380);
    expect(380 - home.y).toBeCloseTo(GROUND_SIZE / 3, 6);
    expect(home.heading).toBe(0);
    expect(home.size).toBe(GROUND_SIZE);
  });

  it('stays landed at its spot on screen, not in the sky, once the view has turned away from the region', () => {
    for (const anchors of [
      [region('r', 195, 380, false)],
      // Facing the camera but past the edge of the ship's room: not on screen as far as the ship goes.
      [region('r', 500, 380)],
      [region('r', 195, 900)],
      [],
    ]) {
      const { home, parked } = place(anchors, 'r');
      expect(parked).toBe(true);
      expect(home).toMatchObject({ x: 195, y: 570, size: GROUND_SIZE, heading: 0 });
    }
  });

  it('keeps its spot clear of a name you could tap', () => {
    const { home } = groundHome({
      anchors: [region('other', 195, 570)],
      regionId: 'r',
      spot,
      avoid: [{ x: 195, y: 570, r: 24 }],
      bounds,
      parked: true,
    });
    expect(home.x).not.toBe(195);
  });

  it('does not cross the screen to its region each time the region touches the edge of its room', () => {
    // The region is back in the room, but far from the ship's spot: a parked ship stays put.
    expect(place([region('r', 60, 300)], 'r', true).parked).toBe(true);
    // The same region with a ship that had not parked: it stands on it.
    expect(place([region('r', 60, 300)], 'r', false).parked).toBe(false);
  });

  it('goes back to its region once the land has slid it under the ship', () => {
    const near = place([region('r', 195 + REATTACH_DISTANCE - 5, 570 + 12)], 'r', true);
    expect(near.parked).toBe(false);
    const far = place([region('r', 195 + REATTACH_DISTANCE + 40, 570)], 'r', true);
    expect(far.parked).toBe(true);
  });

  it('with no region named, stands at its spot', () => {
    expect(place([region('r', 195, 380)], null).parked).toBe(true);
  });
});

describe('what the "you are here" pill names', () => {
  const at = (id: string | null) => (id === null ? () => null : () => id);
  const settled: StandsInput = {
    busy: false,
    free: false,
    parked: false,
    regionId: 'home',
    speed: 0,
    foot: { x: 195.4, y: 590.6 },
    regionAt: at('under'),
  };

  it('names the region the ship stands over, riding that region’s own point', () => {
    expect(standsOf(settled)).toEqual({ id: 'home', at: null });
  });

  it('names the opened region under a ship that stands at its own spot, hung under the ship', () => {
    expect(standsOf({ ...settled, parked: true })).toEqual({ id: 'under', at: { x: 195, y: 591 } });
    expect(standsOf({ ...settled, free: true })).toEqual({ id: 'under', at: { x: 195, y: 591 } });
  });

  it('names nothing over the sea or over land not reached', () => {
    expect(standsOf({ ...settled, parked: true, regionAt: at(null) })).toBe(NOWHERE);
    expect(standsOf({ ...settled, free: true, regionAt: () => null })).toBe(NOWHERE);
  });

  it('names nothing when the world cannot say what is under it', () => {
    expect(standsOf({ ...settled, parked: true, regionAt: undefined })).toBe(NOWHERE);
    expect(standsOf({ ...settled, regionId: null, regionAt: undefined })).toBe(NOWHERE);
  });

  it('is not shown while the ship is held, lifted, flying or hidden', () => {
    expect(standsOf({ ...settled, busy: true })).toBe(NOWHERE);
    expect(standsOf({ ...settled, busy: true, parked: true })).toBe(NOWHERE);
  });

  it('waits for a ship that is still gliding to its spot before it says what is under it', () => {
    expect(standsOf({ ...settled, parked: true, speed: REST_SPEED + 1 })).toBe(NOWHERE);
    expect(standsOf({ ...settled, parked: true, speed: REST_SPEED - 1 })).toEqual({
      id: 'under',
      at: { x: 195, y: 591 },
    });
  });

  it('asks the land under the ship’s fins, never the ship’s middle', () => {
    const asked: [number, number][] = [];
    standsOf({ ...settled, parked: true, regionAt: (x, y) => (asked.push([x, y]), null) });
    expect(asked).toEqual([[195.4, 590.6]]);
  });
});
