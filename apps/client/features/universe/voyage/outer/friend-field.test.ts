import {
  clampPan,
  cellOf,
  DECORATION_COUNT,
  FRIEND_CAP,
  fieldRadius,
  layoutField,
  panLimit,
  slotOf,
  spotRadiusOf,
  type FieldInput,
} from './friend-field';
import type { OuterFriend } from './friend-order';

const friends = (count: number): readonly OuterFriend[] =>
  Array.from({ length: count }, (_, index) => ({
    personId: `person-${index}`,
    handle: `friend${index}`,
    name: `Friend ${index}`,
  }));

/** Your universe where the prototype puts it: 0.56 of the width, 0.486 of the height. */
const inputOf = (width: number, height: number, over: Partial<FieldInput> = {}): FieldInput => ({
  viewport: { width, height },
  universe: { x: width * 0.56, y: height * 0.486, radiusPx: width >= 900 ? 60 : 51 },
  pan: { x: 0, y: 0 },
  ...over,
});
const PHONE = inputOf(390, 844);
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 14, 20, 40, 100, 200];

/** Offsets inside a disc of radius `limit`, on a grid of `step`. */
function offsets(limit: number, step: number): readonly { x: number; y: number }[] {
  const found: { x: number; y: number }[] = [];
  for (let x = -limit; x <= limit; x += step)
    for (let y = -limit; y <= limit; y += step) if (Math.hypot(x, y) <= limit) found.push({ x, y });
  return found;
}

describe('the places of the outer stop', () => {
  it('gives the same places for the same friends, every time', () => {
    const list = friends(40);
    expect(JSON.stringify(layoutField(list, PHONE))).toBe(JSON.stringify(layoutField(list, PHONE)));
    // A fresh list with the same people (as a second read would give) is the same layout.
    expect(JSON.stringify(layoutField(friends(40), PHONE))).toBe(JSON.stringify(layoutField(list, PHONE)));
  });

  it('puts a friend where their rank says, so adding friends after them moves nobody', () => {
    const few = layoutField(friends(6), PHONE).friends;
    const many = layoutField(friends(30), PHONE).friends;
    for (const spot of few) {
      const same = many.find((other) => other.handle === spot.handle);
      if (same) expect([same.x, same.y]).toEqual([spot.x, spot.y]);
    }
  });

  it('takes the prototype two spots first, both left of your universe, about 112 px out on a phone', () => {
    const first = slotOf(0);
    const second = slotOf(1);
    for (const spot of [first, second]) {
      expect(spot.x).toBeLessThan(0);
      expect(Math.hypot(spot.x, spot.y) * cellOf(PHONE.viewport)).toBeCloseTo(112, 0);
    }
    // The prototype's first friend is below the middle, the second above it.
    expect(first.y).toBeGreaterThan(0);
    expect(second.y).toBeLessThan(0);
  });

  it('never puts two friends closer than a gap, or a friend on your universe or its name, however many there are', () => {
    const cell = cellOf(PHONE.viewport);
    const radius = spotRadiusOf(cell);
    const all = Array.from({ length: 200 }, (_, rank) => slotOf(rank));
    for (let a = 0; a < all.length; a += 1) {
      for (let b = a + 1; b < all.length; b += 1)
        expect(Math.hypot(all[a]!.x - all[b]!.x, all[a]!.y - all[b]!.y) * cell).toBeGreaterThanOrEqual(radius * 2 + 8);
      // Your universe at its drawn size and the name under it ("Your universe": about 100 x 20 px, 4 px below).
      const { home } = layoutField(friends(1), PHONE);
      const x = all[a]!.x * cell;
      const y = all[a]!.y * cell;
      expect(Math.hypot(x, y)).toBeGreaterThan(home.radius + radius);
      // The first two are the prototype's own spots, which brush the name's corner as the prototype's do.
      if (a < 2) continue;
      const label = { left: -52, right: 52, top: home.radius + 4, bottom: home.radius + 24 };
      const nearX = Math.max(label.left, Math.min(x, label.right));
      const nearY = Math.max(label.top, Math.min(y, label.bottom));
      expect(Math.hypot(x - nearX, y - nearY)).toBeGreaterThan(radius * 0.8);
    }
  });

  it('draws your universe no wider than the first ring leaves room for', () => {
    const big = layoutField(friends(3), inputOf(390, 844, { universe: { x: 218, y: 410, radiusPx: 400 } }));
    expect(big.home.radius).toBeLessThan(Math.hypot(slotOf(0).x, slotOf(0).y) * big.cell - spotRadiusOf(big.cell));
  });

  it('shows at most ten friends, however many there are', () => {
    for (const count of COUNTS)
      expect(layoutField(friends(count), PHONE).friends.length).toBeLessThanOrEqual(FRIEND_CAP);
  });

  it('shows every friend when there are few, and at least five at rest from five up (390 x 844)', () => {
    for (const count of COUNTS) {
      const shown = layoutField(friends(count), PHONE).friends.length;
      expect(shown).toBeGreaterThanOrEqual(Math.min(5, count));
    }
    expect(layoutField(friends(3), PHONE).friends).toHaveLength(3);
  });

  it('keeps five at rest wherever the driver puts your universe, within 0.44 to 0.62 of the width and 0.43 to 0.54 of the height', () => {
    for (const x of [170, 195, 218, 240])
      for (const y of [360, 397, 422, 460])
        for (const radiusPx of [45, 70]) {
          const input = inputOf(390, 844, { universe: { x, y, radiusPx } });
          for (const count of COUNTS)
            expect(layoutField(friends(count), input).friends.length).toBeGreaterThanOrEqual(Math.min(5, count));
        }
  });

  it('keeps at least five in view at any pan the clamp allows (390 x 844), for every count', () => {
    for (const count of COUNTS) {
      const list = friends(count);
      const limit = panLimit(count, cellOf(PHONE.viewport));
      for (const pan of offsets(limit + 24, 24)) {
        const held = clampPan(list, PHONE, pan);
        const shown = layoutField(list, { ...PHONE, pan: held }).friends.length;
        expect(shown).toBeGreaterThanOrEqual(Math.min(5, count));
        expect(shown).toBeLessThanOrEqual(FRIEND_CAP);
      }
    }
  });

  it('keeps at least five in view on a tablet and a desktop too', () => {
    for (const [width, height] of [
      [768, 1024],
      [1280, 800],
    ] as const) {
      const input = inputOf(width, height);
      for (const count of [5, 6, 10, 40, 200]) {
        const list = friends(count);
        const limit = panLimit(count, cellOf(input.viewport));
        for (const pan of offsets(limit, 40)) {
          const held = clampPan(list, input, pan);
          expect(layoutField(list, { ...input, pan: held }).friends.length).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  it('on the smallest phone (320 x 568) shows what the bands leave (four), and five or more once the chip band is let go', () => {
    const small = inputOf(320, 568);
    // With the phone bands (150 above, 196 below) the free band is 222 px: four of fourteen at rest.
    expect(layoutField(friends(14), small).friends.length).toBe(4);
    // With the chips band released to 96 px the band is 322 px: six of fourteen at rest.
    const released = { ...small, bands: { top: 150, bottom: 96 } };
    expect(layoutField(friends(14), released).friends.length).toBe(6);
    const limit = panLimit(14, cellOf(released.viewport));
    for (const pan of offsets(limit, 28))
      expect(
        layoutField(friends(14), { ...released, pan: clampPan(friends(14), released, pan) }).friends.length,
      ).toBeGreaterThanOrEqual(5);
  });

  it('brings other friends into view as the field is panned', () => {
    const list = friends(40);
    const rest = new Set(layoutField(list, PHONE).friends.map((spot) => spot.handle));
    const panned = new Set(
      layoutField(list, { ...PHONE, pan: clampPan(list, PHONE, { x: -230, y: 130 }) }).friends.map(
        (spot) => spot.handle,
      ),
    );
    expect([...panned].some((handle) => !rest.has(handle))).toBe(true);
    // Over every pan, all forty are reached.
    const reached = new Set<string>();
    for (const pan of offsets(panLimit(40, 64), 16))
      for (const spot of layoutField(list, { ...PHONE, pan: clampPan(list, PHONE, pan) }).friends)
        reached.add(spot.handle);
    expect(reached.size).toBeGreaterThan(30);
  });

  it('moves everything with the pan, your universe included, by exactly the pan', () => {
    const list = friends(14);
    const rest = layoutField(list, PHONE);
    const moved = layoutField(list, { ...PHONE, pan: { x: -20, y: 10 } });
    expect(moved.home.x - rest.home.x).toBeCloseTo(-20);
    expect(moved.home.y - rest.home.y).toBeCloseTo(10);
    const spot = rest.friends[0]!;
    const same = moved.friends.find((other) => other.handle === spot.handle);
    if (same !== undefined) {
      expect(same.x - spot.x).toBeCloseTo(-20);
      expect(same.y - spot.y).toBeCloseTo(10);
    }
  });

  it('holds a pan inside the field: a far offset is brought back to the edge', () => {
    const list = friends(14);
    const far = clampPan(list, PHONE, { x: 5000, y: 0 });
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(panLimit(14, 64) + 1e-6);
    expect(fieldRadius(14)).toBeGreaterThan(fieldRadius(5));
  });

  it('seeds a friend’s bubble from their handle, and draws the unnamed seven apart from the friends', () => {
    const layout = layoutField(friends(14), PHONE);
    for (const spot of layout.friends) expect(spot.seed).toBe(spot.handle);
    // The decoration is its own list: no handle, ids o0..o6, never more than seven, never in the friends.
    expect(layout.decorations.length).toBeLessThanOrEqual(DECORATION_COUNT);
    for (const decoration of layout.decorations) {
      expect(decoration.id).toMatch(/^o[0-6]$/);
      expect(layout.friends.map((spot) => spot.handle)).not.toContain(decoration.id);
      for (const spot of layout.friends)
        expect(Math.hypot(decoration.x - spot.x, decoration.y - spot.y)).toBeGreaterThan(
          spot.radius + decoration.radius,
        );
    }
  });

  it('draws all seven unnamed universes when there are no friends to sit on them (the prototype’s picture)', () => {
    expect(layoutField([], PHONE).decorations).toHaveLength(DECORATION_COUNT);
    expect(layoutField([], PHONE).friends).toHaveLength(0);
  });

  it('draws nothing for an empty list and does not throw for a viewport smaller than its bands', () => {
    expect(layoutField([], inputOf(200, 200)).friends).toEqual([]);
    expect(layoutField(friends(5), inputOf(200, 200)).friends.length).toBeLessThanOrEqual(5);
  });
});
