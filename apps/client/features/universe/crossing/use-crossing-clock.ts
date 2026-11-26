import { useEffect, useState } from 'react';
import { advanceClock, startClock } from '../space/frame-clock';

/**
 * The film time `q`, 0 to 1, of a film that lasts `seconds` and plays from the moment this mounts (when `playing`). It
 * runs on the space views' frame clock (30 fps, one step never more than 0.1 s). Not playing: `q` stays at 0. It ends at 1
 * and stays there.
 */
export function useCrossingClock(playing: boolean, seconds: number): number {
  const [q, setQ] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let clock = startClock();
    let handle = 0;
    const tick = (nowMs: number): void => {
      const step = advanceClock(clock, nowMs);
      clock = step.clock;
      if (step.draw) {
        const next = Math.min(1, clock.t / seconds);
        setQ(next);
        if (next >= 1) return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, seconds]);
  return q;
}
