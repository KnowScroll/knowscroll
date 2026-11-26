import { act, renderHook } from '@testing-library/react-native';
import { useCrossingClock } from './use-crossing-clock';

// The real hook and the real frame clock; only requestAnimationFrame is driven by hand.
let pending = new Map<number, (nowMs: number) => void>();
let nextHandle = 1;
beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
    pending.delete(handle ?? -1);
  });
});
afterEach(() => jest.restoreAllMocks());

/** Delivers the frames that are waiting, stamped `nowMs`. */
const frame = (nowMs: number) => {
  const waiting = [...pending.values()];
  pending.clear();
  return act(() => waiting.forEach((callback) => callback(nowMs)));
};

describe('the crossing clock', () => {
  it('asks for no frame and stays at 0 when it is not playing (reduced motion, or a still)', async () => {
    const { result } = await renderHook(() => useCrossingClock(false, 2));
    expect(pending.size).toBe(0);
    expect(result.current).toBe(0);
  });

  it('runs film time from the first frame: 0.1 s a frame of a 2 s film is 0.05 of it', async () => {
    const { result } = await renderHook(() => useCrossingClock(true, 2));
    await frame(1000);
    expect(result.current).toBe(0);
    await frame(1100);
    expect(result.current).toBeCloseTo(0.05);
    await frame(1200);
    expect(result.current).toBeCloseTo(0.1);
  });

  it('stops at 1 and asks for nothing more', async () => {
    const { result } = await renderHook(() => useCrossingClock(true, 0.25));
    for (const at of [0, 100, 200, 300]) await frame(at);
    expect(result.current).toBe(1);
    expect(pending.size).toBe(0);
  });

  it('cancels its waiting frame when it unmounts', async () => {
    const { unmount } = await renderHook(() => useCrossingClock(true, 2));
    await frame(0);
    expect(pending.size).toBe(1);
    await unmount();
    expect(pending.size).toBe(0);
  });

  it('cancels its waiting frame when playing is switched off', async () => {
    const { rerender } = await renderHook(({ playing }: { playing: boolean }) => useCrossingClock(playing, 2), {
      initialProps: { playing: true },
    });
    await frame(0);
    expect(pending.size).toBe(1);
    await rerender({ playing: false });
    expect(pending.size).toBe(0);
  });
});
