import { crossingFrame, crossingSeconds, type CrossingFrame } from './crossing-frame';

const PHONE = { width: 390, height: 844 };
const NAMES = ['Attention', 'Stars', 'Orbits', 'Tides', 'Maps'];

const out = (q: number, extra: { names?: readonly string[]; seconds?: number; reducedMotion?: boolean } = {}) =>
  crossingFrame(q, 'out', { size: PHONE, friendName: 'Ravi', names: NAMES, ...extra });
const home = (q: number) => crossingFrame(q, 'home', { size: PHONE, friendName: 'Ravi', names: NAMES });

const label = (frame: CrossingFrame, key: string) => frame.labels.find((entry) => entry.key === key);
const nameIndexes = (frame: CrossingFrame) => frame.names.map((entry) => entry.index);

describe('the crossing film, beat by beat', () => {
  it('lasts 7.5 s the first time, 3.6 s after and 3.8 s going home', () => {
    expect(crossingSeconds('out', false)).toBe(7.5);
    expect(crossingSeconds('out', true)).toBe(3.6);
    expect(crossingSeconds('home', false)).toBe(3.8);
    expect(crossingSeconds('home', true)).toBe(3.8);
  });

  it('is a pure function of q: the same inputs give the same frame, and q is clamped', () => {
    expect(out(0.37)).toEqual(out(0.37));
    expect(out(-1)).toEqual(out(0));
    expect(out(2)).toEqual(out(1));
    expect(out(0.5).seconds).toBeCloseTo(3.75);
    expect(out(0.5, { seconds: 3.6 }).seconds).toBeCloseTo(1.8);
  });

  it('shows "Setting course" fully at q 0.10 (0.75 s) and not at all by 0.16', () => {
    const early = label(out(0.1), 'course');
    expect(early?.text).toBe('Setting course for Ravi’s universe');
    expect(early?.alpha).toBeCloseTo(1);
    expect(early?.x).toBeCloseTo(195);
    expect(early?.y).toBeCloseTo(844 * 0.19);
    expect(label(out(0.16), 'course')).toBeUndefined();
    expect(label(out(0.0), 'course')).toBeUndefined();
  });

  it('has "A way through opens" from q 0.20 and none from 0.38, when the ball takes the whole screen', () => {
    expect(label(out(0.1), 'opens')).toBeUndefined();
    expect(label(out(0.3), 'opens')?.alpha).toBeCloseTo(1, 1);
    expect(label(out(0.3), 'opens')?.text).toBe('A way through opens');
    expect(label(out(0.38), 'opens')).toBeUndefined();
  });

  it('slides your universe down and left while theirs comes round to dead ahead', () => {
    const start = out(0);
    expect(start.behind).toMatchObject({ x: 195, y: 422, alpha: 1 });
    expect(start.behind?.radius).toBeCloseTo(0.44 * 390);
    expect(start.ahead).toMatchObject({ x: 195 + 390 * 0.27, y: 844 * 0.25 });
    const turned = out(0.16);
    expect(turned.behind?.alpha).toBeCloseTo(1);
    expect(turned.ahead?.x).toBeCloseTo(195);
    expect(turned.ahead?.y).toBeCloseTo(844 * 0.43);
    expect(out(0.3).behind).toBeNull();
  });

  it('closes a ring of four arcs on their universe between q 0.04 and 0.15', () => {
    const wide = out(0.04).ring;
    const closed = out(0.15).ring;
    const bubble = 390 * 0.085;
    expect(wide?.arcCount).toBe(4);
    expect(wide?.arcLength).toBeCloseTo(0.9);
    expect(wide?.radius).toBeCloseTo(bubble * 3.4);
    expect(closed?.radius).toBeCloseTo(bubble * 1.5);
    expect(out(0.3).ring).toBeNull();
    expect(label(out(0.1), 'ring')?.text).toBe('Ravi’s universe');
  });

  it('opens the ball to 0.2 of the short side, then blows it up past the screen by the end of the dive', () => {
    expect(out(0.3).shader.ballRadius).toBeGreaterThan(0.2);
    expect(out(0.3).shader.ballRadius).toBeLessThan(0.3);
    const halfDiagonalInShortSides = Math.hypot(PHONE.width, PHONE.height) / 2 / Math.min(PHONE.width, PHONE.height);
    expect(out(0.42).shader.ballRadius).toBeCloseTo(3, 5);
    expect(out(0.42).shader.ballRadius).toBeGreaterThan(halfDiagonalInShortSides);
    expect(out(0.1).shader.ballRadius).toBe(0);
  });

  it('runs the throat from 0.36, amber to violet to teal, with the far mouth growing to fill the screen', () => {
    expect(out(0.3).shader.open).toBe(0);
    expect(out(0.45).shader.open).toBe(1);
    expect(out(0.4).shader.tint).toBe(0);
    expect(out(0.8).shader.tint).toBe(1);
    expect(out(0.45).shader.farRadius).toBeCloseTo(0.07);
    expect(out(0.74).shader.farRadius).toBeCloseTo(0.14);
    expect(out(0.95).shader.farRadius).toBeCloseTo(0.14 * 27);
    expect(out(0.95).shader.glow).toBeCloseTo(1.1);
    expect(out(0.5).shader).toMatchObject({ twist: 2.4, speed: 0.5, seed: 3, dark: 0 });
    expect(out(0.5).shader.colours).toEqual({ a: '#FFC98A', m: '#B79BFF', b: '#5EF0DC' });
  });

  it('keeps the shader centre on the screen centre line and 0.43 down, swaying only inside the throat', () => {
    expect(out(0).shader.centre[0]).toBeCloseTo(0);
    expect(out(0).shader.centre[1]).toBeCloseTo((0.5 - 0.43) * (844 / 390));
    expect(out(0.2).shader.centre[0]).toBeCloseTo(0);
    expect(Math.abs(out(0.6).shader.centre[0])).toBeLessThanOrEqual(20 / 390 + 1e-9);
  });

  it('drifts the names out one at a time: one at q 0.50, two at 0.64, and the first has gone by 0.69', () => {
    expect(nameIndexes(out(0.46))).toEqual([]);
    expect(nameIndexes(out(0.5))).toEqual([0]);
    expect(nameIndexes(out(0.64))).toEqual([0, 1]);
    expect(nameIndexes(out(0.7))).toEqual([1]);
    expect(out(0.64).names.map((entry) => entry.text)).toEqual(['Attention', 'Stars']);
    expect(label(out(0.5), 'common')?.text).toBe('What you have in common');
    expect(label(out(0.64), 'common')?.alpha).toBeGreaterThan(0.9);
    expect(label(out(0.8), 'common')).toBeUndefined();
    const first = out(0.5).names[0]!;
    expect(first.size).toBeCloseTo(12 + 14 * (0.03 / 0.22));
    expect(first.alpha).toBeGreaterThan(0);
  });

  it('shows no line in common when nothing is shared', () => {
    const frame = out(0.55, { names: [] });
    expect(frame.names).toEqual([]);
    expect(label(frame, 'common')).toBeUndefined();
  });

  it('flashes white only after 0.92 and almost fully at 0.995', () => {
    expect(out(0.9).flash).toBe(0);
    expect(out(0.92).flash).toBe(0);
    expect(out(0.96).flash).toBeGreaterThan(0.3);
    expect(out(0.96).flash).toBeLessThan(0.7);
    expect(out(0.995).flash).toBeGreaterThan(0.99);
    expect(out(1).flash).toBe(1);
  });

  it('shakes twice, at q 0.39 and 0.91, by no more than 5 px, and never with reduced motion', () => {
    const still = out(0.2).shake;
    expect(Math.hypot(still.x, still.y)).toBeLessThan(1e-6);
    let strongest = 0;
    for (let q = 0.37; q < 0.41; q += 0.0005)
      strongest = Math.max(strongest, Math.hypot(out(q).shake.x, out(q).shake.y));
    expect(strongest).toBeGreaterThan(2);
    expect(strongest).toBeLessThanOrEqual(5 * Math.SQRT2);
    expect(out(0.39, { reducedMotion: true }).shake).toEqual({ x: 0, y: 0 });
  });
});

describe('the way home', () => {
  it('swaps the colours and has no names in common', () => {
    expect(home(0.5).shader.colours).toEqual({ a: '#5EF0DC', m: '#B79BFF', b: '#FFC98A' });
    expect(home(0.5).names).toEqual([]);
    expect(label(home(0.5), 'common')).toBeUndefined();
    expect(home(0.64).names).toEqual([]);
  });

  it('says "Setting course for home" and "Home" in place of the friend', () => {
    expect(label(home(0.1), 'course')?.text).toBe('Setting course for home');
    expect(label(home(0.1), 'ring')?.text).toBe('Home');
  });

  it('is the same film at its own length (3.8 s)', () => {
    expect(home(0.5).seconds).toBeCloseTo(1.9);
    expect(home(0.42).shader.ballRadius).toBeCloseTo(3, 5);
  });
});

describe('a different screen', () => {
  it('keeps shader units to the short side and marks to the smaller of the width and 62 % of the height', () => {
    const wide = crossingFrame(0, 'out', { size: { width: 800, height: 600 } });
    expect(wide.behind?.radius).toBeCloseTo(0.44 * Math.min(800, 600 * 0.62));
    expect(wide.shader.centre[1]).toBeCloseTo((0.5 - 0.43) * (600 / 600));
  });

  it('keeps a centred label on the screen, as the prototype does', () => {
    const narrow = crossingFrame(0.1, 'out', { size: { width: 280, height: 600 }, friendName: 'Ravi' });
    const course = label(narrow, 'course')!;
    expect(course.x).toBeGreaterThan(0);
    expect(course.x).toBeLessThan(280);
  });
});
