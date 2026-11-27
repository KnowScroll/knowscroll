import {
  ANNOUNCE_BY_Q,
  CUT_SECONDS,
  NAMES_DECIDED_AT_Q,
  SKIP_TO_Q,
  STOP_BEFORE_Q,
  UNKNOWN_FRIEND,
  createCrossingDirector,
  type CrossingWorld,
} from './crossing-director';

const FIRST = 7.5;
const SHORT = 3.6;
const ready = (shared: readonly string[] | null = ['Attention', 'Stars']): CrossingWorld => ({
  status: 'ready',
  name: 'Ravi',
  shared: shared ?? undefined,
});
/** A film of `seconds` that has played to film time `q`, on a clock that started with it. */
const playTo = (director: ReturnType<typeof createCrossingDirector>, q: number) =>
  director.advance(q * director.getState().seconds);
const startOut = (seconds = FIRST, cut = false) => {
  const director = createCrossingDirector();
  director.start({ direction: 'out', seconds, cut });
  return director;
};

describe('the crossing director', () => {
  it('starts idle, and a film plays through to the white of the arrival, which then clears', () => {
    const director = createCrossingDirector();
    expect(director.getState().mode).toBe('idle');
    director.start({ direction: 'out', seconds: FIRST, cut: false });
    expect(director.getState()).toMatchObject({ mode: 'film', direction: 'out', seconds: FIRST, q: 0, ended: null });
    playTo(director, 0.5);
    expect(director.getState().q).toBeCloseTo(0.5);
    director.advance(FIRST + 1);
    expect(director.getState()).toMatchObject({ mode: 'arrival', q: 1, ended: 'finished' });
    director.arrived();
    expect(director.getState()).toMatchObject({ mode: 'idle', announcement: null });
  });

  it('keeps the length it was given: 7.5 s the first time, 3.6 s after, 3.8 s home', () => {
    for (const [direction, seconds] of [
      ['out', FIRST],
      ['out', SHORT],
      ['home', 3.8],
    ] as const) {
      const director = createCrossingDirector();
      director.start({ direction, seconds, cut: false });
      director.advance(seconds / 2);
      expect(director.getState().q).toBeCloseTo(0.5);
    }
  });

  describe('a refusal or a lost connection', () => {
    it('stops the film just before q 0.3 and not at it', () => {
      const early = startOut();
      playTo(early, STOP_BEFORE_Q - 0.001);
      early.world({ status: 'gone' });
      expect(early.getState()).toMatchObject({ mode: 'idle', ended: 'stopped', announcement: null });

      const late = startOut();
      playTo(late, STOP_BEFORE_Q);
      late.world({ status: 'gone' });
      expect(late.getState().mode).toBe('film');
      // After 0.3 the film finishes, and what is under it is what the person lands on.
      late.advance(FIRST);
      expect(late.getState()).toMatchObject({ mode: 'arrival', ended: 'finished' });
    });

    it('stops it for a refusal in the first frames, and never starts one for a refusal it already knows', () => {
      const director = startOut();
      director.world({ status: 'gone' });
      expect(director.getState()).toMatchObject({ mode: 'idle', ended: 'stopped' });
      const known = createCrossingDirector();
      known.world({ status: 'gone' });
      known.start({ direction: 'out', seconds: FIRST, cut: false });
      expect(known.getState().mode).toBe('idle');
    });

    it('does not stop the film home: you are leaving a visit that was shown', () => {
      const director = createCrossingDirector();
      director.start({ direction: 'home', seconds: 3.8, cut: false });
      director.world({ status: 'gone' });
      expect(director.getState().mode).toBe('film');
    });
  });

  describe('the names in common', () => {
    it('are the ones the read has by q 0.47, fixed from then on', () => {
      const director = startOut();
      director.world(ready());
      playTo(director, NAMES_DECIDED_AT_Q - 0.001);
      expect(director.getState().names).toEqual([]);
      playTo(director, NAMES_DECIDED_AT_Q);
      expect(director.getState().names).toEqual(['Attention', 'Stars']);
      // A later change of the list changes nothing in this film.
      director.world(ready(['Other']));
      playTo(director, 0.6);
      expect(director.getState().names).toEqual(['Attention', 'Stars']);
    });

    it('are none when the read is not back by q 0.47, even if it arrives a moment later', () => {
      const director = startOut();
      playTo(director, NAMES_DECIDED_AT_Q);
      director.world(ready());
      playTo(director, 0.7);
      expect(director.getState().names).toEqual([]);
    });

    it('are none when your own names are not in hand, and none going home', () => {
      const director = startOut();
      director.world(ready(null));
      playTo(director, 0.6);
      expect(director.getState().names).toEqual([]);
      const home = createCrossingDirector();
      home.world(ready());
      home.start({ direction: 'home', seconds: 3.8, cut: false });
      playTo(home, 0.6);
      expect(home.getState().names).toEqual([]);
    });

    it('are fixed at the same film time in the short film', () => {
      const director = startOut(SHORT);
      director.world(ready());
      playTo(director, NAMES_DECIDED_AT_Q - 0.01);
      expect(director.getState().names).toEqual([]);
      playTo(director, NAMES_DECIDED_AT_Q);
      expect(director.getState().names).toEqual(['Attention', 'Stars']);
    });
  });

  describe('skipping', () => {
    it('goes to q 0.985 at once, and the rest of the film is the last moments', () => {
      const director = startOut();
      director.world(ready());
      playTo(director, 0.2);
      director.skip();
      expect(director.getState()).toMatchObject({ q: SKIP_TO_Q, skipped: true, mode: 'film' });
      // The clock goes on from where it was: the last 1.5 % of 7.5 s is 0.11 s, so 0.2 s later the film is past its end.
      director.advance(0.2 * FIRST + 0.2);
      expect(director.getState()).toMatchObject({ mode: 'arrival', ended: 'skipped', q: 1 });
    });

    it('with the names not yet fixed leaves them out, and a second tap changes nothing', () => {
      const director = startOut();
      director.world(ready());
      playTo(director, 0.1);
      director.skip();
      expect(director.getState().names).toEqual([]);
      const before = director.getState();
      director.skip();
      expect(director.getState()).toBe(before);
    });

    it('ends a reduced-motion cut at once, and does nothing when nothing plays', () => {
      const idle = createCrossingDirector();
      idle.skip();
      expect(idle.getState().mode).toBe('idle');
      const cut = startOut(FIRST, true);
      cut.skip();
      expect(cut.getState()).toMatchObject({ mode: 'idle', ended: 'skipped', cut: true });
    });
  });

  describe('reduced motion', () => {
    it('is a dark cut of about a quarter of a second, with no white at its end', () => {
      const director = startOut(FIRST, true);
      expect(director.getState()).toMatchObject({ mode: 'cut', seconds: CUT_SECONDS, cut: true });
      director.advance(CUT_SECONDS / 2);
      expect(director.getState().mode).toBe('cut');
      director.advance(CUT_SECONDS);
      expect(director.getState()).toMatchObject({ mode: 'idle', ended: 'finished', q: 1 });
    });
  });

  describe('the line for the screen reader', () => {
    it('is empty before anything starts, and says where you are going once the name is known', () => {
      const director = createCrossingDirector();
      expect(director.getState().announcement).toBeNull();
      director.world(ready());
      director.start({ direction: 'out', seconds: FIRST, cut: false });
      expect(director.getState().announcement).toBe('Going to Ravi’s universe');
    });

    it('waits for the name, and does not wait past q 0.05; then it never changes', () => {
      const director = startOut();
      expect(director.getState().announcement).toBeNull();
      playTo(director, ANNOUNCE_BY_Q - 0.001);
      expect(director.getState().announcement).toBeNull();
      director.world(ready());
      expect(director.getState().announcement).toBe('Going to Ravi’s universe');

      const slow = startOut();
      playTo(slow, ANNOUNCE_BY_Q);
      expect(slow.getState().announcement).toBe(`Going to ${UNKNOWN_FRIEND}’s universe`);
      slow.world(ready());
      playTo(slow, 0.2);
      expect(slow.getState().announcement).toBe(`Going to ${UNKNOWN_FRIEND}’s universe`);
      expect(slow.getState().friendName).toBe('Ravi');
    });

    it('says "Going home" on the way home, as a change from nothing, and is cleared when the crossing is over', () => {
      const director = startOut();
      director.world(ready());
      director.advance(FIRST);
      director.arrived();
      expect(director.getState().announcement).toBeNull();
      director.start({ direction: 'home', seconds: 3.8, cut: false });
      expect(director.getState().announcement).toBe('Going home');
      director.advance(3.8);
      expect(director.getState().announcement).toBe('Going home');
      director.arrived();
      expect(director.getState().announcement).toBeNull();
    });

    it('is made in a cut too, at once', () => {
      const director = startOut(FIRST, true);
      expect(director.getState().announcement).toBe(`Going to ${UNKNOWN_FRIEND}’s universe`);
    });
  });

  describe('a second start', () => {
    it('does not restart a crossing already going the same way, and going home replaces one going out', () => {
      const director = startOut();
      director.world(ready());
      playTo(director, 0.4);
      const before = director.getState();
      director.start({ direction: 'out', seconds: SHORT, cut: false });
      expect(director.getState()).toBe(before);
      director.start({ direction: 'home', seconds: 3.8, cut: false });
      expect(director.getState()).toMatchObject({ direction: 'home', q: 0, runs: 2, seconds: 3.8 });
      director.start({ direction: 'home', seconds: 3.8, cut: false });
      expect(director.getState().runs).toBe(2);
    });
  });

  it('tells its listeners of every change and stops telling one that has gone', () => {
    const director = createCrossingDirector();
    const heard = jest.fn();
    const stop = director.subscribe(heard);
    director.start({ direction: 'out', seconds: FIRST, cut: false });
    director.advance(1);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    director.advance(2);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
