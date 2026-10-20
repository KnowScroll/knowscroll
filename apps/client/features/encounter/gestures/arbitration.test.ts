import { createGestureArbitrator } from './arbitration';
const create = (overrides = {}) =>
  createGestureArbitrator({ startX: 80, scroll: false, childOwns: false, native: true, ...overrides });
describe('navigation gesture ownership', () => {
  it('retains child ownership through release, including sliders, diagrams and code scrolling', () => {
    const gesture = create({ childOwns: true });
    expect(gesture.move(-120, 2)).toBe('child');
    expect(gesture.release()).toBeUndefined();
  });
  it('preserves native system Back edge ownership', () => {
    const gesture = create({ startX: 12 });
    expect(gesture.move(120, 0)).toBe('platform_back');
    expect(gesture.release()).toBeUndefined();
  });
  it('locks a Scroll vertical read through momentum and boundary; a fresh horizontal gesture can continue', () => {
    const reading = create({ scroll: true });
    expect(reading.move(0, -30)).toBe('reading');
    expect(reading.move(-140, -100)).toBe('reading');
    expect(reading.release()).toBeUndefined();
    const fresh = create({ scroll: true });
    expect(fresh.move(-30, 0)).toBe('horizontal');
    fresh.move(-90, 5);
    expect(fresh.release()).toBe('next');
  });
  it('never commits an interrupted or short gesture, and locks a Reel gesture axis', () => {
    const cancelled = create();
    cancelled.move(-120, 2);
    cancelled.cancel();
    expect(cancelled.release()).toBeUndefined();
    const short = create();
    short.move(-32, 0);
    expect(short.release()).toBeUndefined();
    const reel = create();
    expect(reel.move(2, -30)).toBe('vertical');
    reel.move(-200, -90);
    expect(reel.release()).toBe('subject');
  });
});
