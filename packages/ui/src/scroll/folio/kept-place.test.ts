import { createKeptPlace } from './kept-place';

describe('createKeptPlace', () => {
  it('holds the stop it opened at until released, and asks only when the scroller is elsewhere', () => {
    const kept = createKeptPlace('stop-3');
    expect(kept.holding()).toBe(true);
    expect(kept.stop()).toBe('stop-3');
    expect(kept.ask(500, 0)).toBe(true);
    expect(kept.ask(500, 300)).toBe(true);
    expect(kept.ask(500, 500.4)).toBe(false);
    kept.release();
    expect(kept.holding()).toBe(false);
    expect(kept.stop()).toBeUndefined();
  });

  it('holds nothing when opened at the start, and can keep a beat later, as the text version does', () => {
    const kept = createKeptPlace(undefined);
    expect(kept.holding()).toBe(false);
    kept.keep('stop-5');
    expect(kept.stop()).toBe('stop-5');
    kept.release();
    expect(kept.holding()).toBe(false);
  });
});
