import { act, renderHook } from '@testing-library/react-native';
import { lerp } from './blend';
import { useStagePictures, type SceneBlend } from './use-stage-pictures';

/**
 * Scenes as a picture's renderer meets them: a view, and a number that can move inside it. The hook knows nothing of what
 * a scene is, only the blend it is given, so a plain one stands in for the pictures' and the kits' own.
 */
interface Scene {
  readonly view: string;
  readonly angle: number;
}
const blend: SceneBlend<Scene> = {
  canTween: (from, to) => from.view === to.view,
  lerpScene: (from, to, progress) => ({ view: to.view, angle: lerp(from.angle, to.angle, progress) }),
};
const shown = (key: string, scene: Scene, source?: string) => ({
  key,
  scene,
  ...(source === undefined ? {} : { kit: source }),
});
const june = shown('june', { view: 'orbit', angle: 100 });
const december = shown('december', { view: 'orbit', angle: 280 });
const close = shown('close', { view: 'close', angle: 100 });

async function run(target: ReturnType<typeof shown>, reducedMotion: boolean, from = june) {
  const hook = await renderHook(
    ({ at }: { at: ReturnType<typeof shown> }) => useStagePictures(at, reducedMotion, blend),
    {
      initialProps: { at: from },
    },
  );
  await hook.rerender({ at: target });
  return hook;
}

describe('the stage picture over time', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows the target at once the first time, with no transition', async () => {
    const { result } = await renderHook(() => useStagePictures(june, false, blend));
    expect(result.current.transition).toBe('none');
    expect(result.current.layers).toHaveLength(1);
  });

  it('glides between scenes inside one view, and ends exactly on the target', async () => {
    const { result } = await run(december, false);
    await act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.transition).toBe('tween');
    expect(result.current.layers).toHaveLength(1);
    const middle = result.current.layers[0]?.scene.angle;
    expect(middle).not.toBe(june.scene.angle);
    expect(middle).not.toBe(december.scene.angle);
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

  it('fades, and never glides, between two sources whose views share a name', async () => {
    const first = { ...june, key: 'first/s1', kit: 'first' };
    const second = { ...december, key: 'second/s1', kit: 'second' };
    const { result } = await run(second, false, first);
    await act(() => {
      jest.advanceTimersByTime(100);
    });
    // Both scenes are in the 'orbit' view, which one source may glide: across sources it is still a fade.
    expect(result.current.transition).toBe('crossfade');
    expect(result.current.layers.map((layer) => layer.key)).toEqual(['first/s1', 'second/s1']);
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
        expect([june.scene.angle, december.scene.angle]).toContain(layer.scene.angle);
    }
    expect(seen.has('tween')).toBe(false);
    expect(seen.has('crossfade')).toBe(true);
    expect(result.current.layers).toHaveLength(1);
  });
});
