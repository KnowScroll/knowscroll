import { act, render } from '@testing-library/react-native';
import { useEffect as mockUseEffect } from 'react';
import { DisplayProvider } from '@knowscroll/ui';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { indexUniverse } from '../universe-layout';
import type { UniverseMapSession, UniverseViewState } from '../universe-session';
import { ZOOM_LIMITS } from './camera-rig';
import type { SpaceCanvasProps } from './space-canvas-props';
import { DETAIL_REPORT_MS, SpaceStage } from './space-stage';

// The real stage, view and model. Only the GPU side is a stand-in that hands the test the options a renderer is made with.
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('./space-canvas', () => ({
  SpaceCanvas: (props: SpaceCanvasProps) => {
    mockUseEffect(() => {
      props.onSurface({ canvas: {}, width: 390, height: 640, pixelRatio: 1 });
    }, []);
    return null;
  },
}));
let mockOptions: { onDetail?: (ids: readonly string[]) => void }[] = [];
jest.mock('./load-space-renderer', () => ({
  loadSpaceRenderer: () =>
    Promise.resolve({
      createSpaceRenderer: (
        _surface: unknown,
        _definition: unknown,
        options: { onDetail?: (ids: readonly string[]) => void },
      ) => {
        mockOptions.push(options);
        return {
          draw: () => undefined,
          resize: () => undefined,
          dispose: () => undefined,
          isFar: () => false,
          setCamera: () => undefined,
          setScript: () => undefined,
          setHighlight: () => undefined,
          setDefinition: () => undefined,
          anchors: () => [],
          probe: () => ({ litPixels: 1, sampledPixels: 2, signature: 3 }),
        };
      },
    }),
}));

const base = sceneFixture(5).descriptors[0]!;
/** `count` systems, each with a star, as the sky and the first system's read give them. */
function systems(count: number): SceneDescriptor[] {
  return Array.from({ length: count }, (_, n): SceneDescriptor[] => {
    const home: SceneDescriptor = {
      ...base,
      objectId: fixtureId(5000 + n * 2),
      parentId: fixtureId(1),
      kind: 'system',
      label: `CI system ${n}`,
      seed: (n + 1).toString(16).padStart(32, '0'),
      anchor: { x: (n % 6) * 900, y: Math.floor(n / 6) * 900, layer: 0 },
      target: { kind: 'system', objectId: fixtureId(5000 + n * 2) },
    };
    return [home];
  }).flat();
}

function fakeSession() {
  return {
    setDetail: jest.fn(),
    setZoomMax: jest.fn(),
    select: jest.fn(),
    focus: jest.fn(),
  } as unknown as UniverseMapSession & { setDetail: jest.Mock; setZoomMax: jest.Mock };
}
const state = {
  read: { status: 'ready', active: true },
  frame: { x: 0, y: 0, scale: 1 },
  selectedId: null,
  lately: false,
  lastPlace: undefined,
  dust: { cues: [] },
} as unknown as UniverseViewState;

async function mount(count: number, session = fakeSession()) {
  mockOptions = [];
  const rendered = await render(
    <DisplayProvider value={{ reducedMotion: true }}>
      <SpaceStage
        session={session}
        state={state}
        index={indexUniverse(systems(count), [])}
        size={{ width: 390, height: 640 }}
        view={{ kind: 'universe' }}
        onUnavailable={() => undefined}
      />
    </DisplayProvider>,
  );
  // The renderer is loaded and made a tick or two after the surface reports.
  for (let tick = 0; tick < 3 && mockOptions.length === 0; tick++)
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 5))));
  return { session, rendered };
}

describe('the space stage of a map at scale (D-417)', () => {
  it('tells the session how far the whole-universe view may zoom: the old limit for a small map, more for a large one', async () => {
    const small = await mount(3);
    expect(small.session.setZoomMax).toHaveBeenLastCalledWith(ZOOM_LIMITS.universe.max);
    const large = await mount(60);
    const [max] = large.session.setZoomMax.mock.calls.at(-1)! as [number];
    expect(max).toBeGreaterThan(ZOOM_LIMITS.universe.max);
  });

  it('forwards the first change of detail at once and the later ones after the camera has settled', async () => {
    const { session, rendered } = await mount(60);
    const report = mockOptions.at(-1)!.onDetail!;
    const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
    report(['a']);
    expect(session.setDetail).toHaveBeenCalledTimes(1);
    expect(session.setDetail).toHaveBeenLastCalledWith(['a']);
    // A pan reports many times; only the last, once it has settled, reaches the session.
    report(['b']);
    report(['c']);
    report(['d']);
    expect(session.setDetail).toHaveBeenCalledTimes(1);
    await wait(DETAIL_REPORT_MS / 2);
    expect(session.setDetail).toHaveBeenCalledTimes(1);
    await wait(DETAIL_REPORT_MS);
    expect(session.setDetail).toHaveBeenCalledTimes(2);
    expect(session.setDetail).toHaveBeenLastCalledWith(['d']);
    // Leaving the screen drops a report that has not been sent.
    report(['e']);
    await rendered.unmount();
    await wait(DETAIL_REPORT_MS * 2);
    expect(session.setDetail).toHaveBeenCalledTimes(2);
  });
});
