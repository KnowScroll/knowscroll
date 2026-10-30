import { act, renderHook } from '@testing-library/react-native';
import { INITIAL_STAGE_STATE, settleStageState, type StageState } from '@knowscroll/scroll-model';
import { sceneOf } from '../kit';
import { useStagePictures } from './use-stage-pictures';

const shown = (key: string, patch: Partial<StageState>) => ({
  key,
  scene: sceneOf(settleStageState({ ...INITIAL_STAGE_STATE, ...patch })),
});
const june = shown('june', { view: 'orbit', earthAt: 'jun' });
const december = shown('december', { view: 'orbit', earthAt: 'dec' });
const close = shown('close', { view: 'earth-close', earthAt: 'jun' });

async function run(target: ReturnType<typeof shown>, reducedMotion: boolean, from = june) {
  const hook = await renderHook(({ at }: { at: ReturnType<typeof shown> }) => useStagePictures(at, reducedMotion), {
    initialProps: { at: from },
  });
  await hook.rerender({ at: target });
  return hook;
}

describe('the stage picture over time', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows the target at once the first time, with no transition', async () => {
    const { result } = await renderHook(() => useStagePictures(june, false));
    expect(result.current.transition).toBe('none');
    expect(result.current.layers).toHaveLength(1);
  });

  it('glides Earth between months inside one view, and ends exactly on the target', async () => {
    const { result } = await run(december, false);
    await act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.transition).toBe('tween');
    expect(result.current.layers).toHaveLength(1);
    const middle = result.current.layers[0]?.scene.earthAngle;
    expect(middle).not.toBe(june.scene.earthAngle);
    expect(middle).not.toBe(december.scene.earthAngle);
    await act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(result.current.layers).toEqual([{ key: 'december', scene: december.scene, opacity: 1 }]);
  });

  it('fades from one picture to another when the view changes', async () => {
    const { result } = await run(close, false);
    await act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.transition).toBe('crossfade');
    expect(result.current.layers.map((layer) => layer.key)).toEqual(['june', 'close']);
    const [out, into] = result.current.layers;
    expect((out?.opacity ?? 0) + (into?.opacity ?? 0)).toBeCloseTo(1, 5);
  });

  it('under reduced motion never draws a step between two states: it cross-fades, even inside one view', async () => {
    const { result } = await run(december, true);
    const seen = new Set<string>();
    for (let step = 0; step < 20; step += 1) {
      await act(() => {
        jest.advanceTimersByTime(16);
      });
      seen.add(result.current.transition);
      for (const layer of result.current.layers)
        expect([june.scene.earthAngle, december.scene.earthAngle]).toContain(layer.scene.earthAngle);
    }
    expect(seen.has('tween')).toBe(false);
    expect(seen.has('crossfade')).toBe(true);
    expect(result.current.layers).toHaveLength(1);
  });
});
