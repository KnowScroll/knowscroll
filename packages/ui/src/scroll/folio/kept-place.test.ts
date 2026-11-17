import { createKeptPlace } from './kept-place';

describe('createKeptPlace', () => {
  it('holds from the opening until released, and asks only when the scroller is elsewhere', () => {
    const kept = createKeptPlace(true);
    expect(kept.holding()).toBe(true);
    expect(kept.ask(500, 0)).toBe(true);
    expect(kept.ask(500, 300)).toBe(true);
    expect(kept.ask(500, 500.4)).toBe(false);
    kept.release();
    expect(kept.holding()).toBe(false);
  });

  it('holds nothing when the essay opens at its start', () => {
    expect(createKeptPlace(false).holding()).toBe(false);
  });
});
