import { act, render, screen } from '@testing-library/react-native';
import { useEffect as mockUseEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { SAMPLE_SPACE } from './space-definition';
import { SpaceSimpleLists } from './space-simple-lists';
import type { SpaceCanvasProps } from './space-canvas-props';
import type { SpaceFailure } from './space-surface';
import { SpaceView } from './space-view';

// The real SpaceView, render loop and clock. Only the GPU side is a stand-in (a canvas host that
// reports a surface, and a renderer that counts draws): no WebGL is claimed here. The browser and
// the emulator prove the pixels (e2e/space-gallery.spec.ts, maestro/space.yaml).
let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));

let mockHost: (props: SpaceCanvasProps) => void = () => undefined;
jest.mock('./space-canvas', () => {
  return {
    SpaceCanvas: (props: SpaceCanvasProps) => {
      mockUseEffect(() => {
        mockHost(props);
      }, []);
      return null;
    },
  };
});

const mockDraw = jest.fn<void, [number]>();
let mockCreateFails = false;
jest.mock('./load-space-renderer', () => ({
  loadSpaceRenderer: () =>
    Promise.resolve({
      createSpaceRenderer: () => {
        if (mockCreateFails) throw new Error('Error creating WebGL context.');
        return {
          draw: mockDraw,
          resize: jest.fn(),
          anchors: () => [
            { id: 'sample-system', kind: 'system', name: 'Sample system', x: 100, y: 100, visible: true },
          ],
          probe: () => ({ litPixels: 1, sampledPixels: 2, signature: 3 }),
          dispose: jest.fn(),
        };
      },
    }),
}));

const surface = { canvas: {}, width: 390, height: 560, pixelRatio: 1.5 };
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

let frameCallbacks: ((nowMs: number) => void)[] = [];
beforeEach(() => {
  mockFocused = true;
  mockCreateFails = false;
  mockDraw.mockReset();
  mockHost = ({ onSurface }) => onSurface(surface);
  frameCallbacks = [];
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function runFrame(nowMs: number): Promise<void> {
  const callbacks = frameCallbacks;
  frameCallbacks = [];
  await act(() => callbacks.forEach((callback) => callback(nowMs)));
}

async function mount(options: { reducedMotion?: boolean } = {}) {
  const failures: SpaceFailure[] = [];
  await render(
    <DisplayProvider value={{ reducedMotion: options.reducedMotion ?? false }}>
      <SpaceView
        definition={SAMPLE_SPACE}
        fallback={() => <SpaceSimpleLists definition={SAMPLE_SPACE} />}
        diagnostics={{ onFrame: () => undefined, onFailure: (reason) => failures.push(reason) }}
      />
    </DisplayProvider>,
  );
  await settle();
  return { failures };
}

describe('the space view', () => {
  it('draws on a 30 fps cadence while the route is focused', async () => {
    await mount();
    await runFrame(1000);
    await runFrame(1016);
    await runFrame(1033);
    expect(mockDraw).toHaveBeenCalledTimes(2);
  });

  it('draws nothing while the route is not focused', async () => {
    mockFocused = false;
    await mount();
    expect(frameCallbacks).toHaveLength(0);
    expect(mockDraw).not.toHaveBeenCalled();
  });

  it('stops its loop when the app leaves the foreground and resumes when it returns', async () => {
    let appState: (state: AppStateStatus) => void = () => undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appState = listener;
      return { remove: jest.fn() };
    });
    await mount();
    await runFrame(1000);
    expect(frameCallbacks).toHaveLength(1);

    await act(() => appState('background'));
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();

    frameCallbacks = [];
    await act(() => appState('active'));
    expect(frameCallbacks).toHaveLength(1);
  });

  it('with reduced motion draws one frame and schedules no loop', async () => {
    await mount({ reducedMotion: true });
    expect(mockDraw).toHaveBeenCalledTimes(1);
    expect(frameCallbacks).toHaveLength(0);
  });

  it('shows the plain lists when the canvas host says WebGL is missing', async () => {
    mockHost = ({ onFailure }) => onFailure('webgl-unavailable');
    const { failures } = await mount();
    expect(screen.getByTestId('ks-space-simple')).toBeTruthy();
    expect(screen.getByText('First sample planet')).toBeTruthy();
    expect(failures).toEqual(['webgl-unavailable']);
  });

  it('shows the plain lists when the WebGL context cannot be created', async () => {
    mockCreateFails = true;
    const { failures } = await mount();
    expect(screen.getByTestId('ks-space-simple')).toBeTruthy();
    expect(failures).toEqual(['context-creation-failed']);
  });

  it('shows the plain lists when a frame fails to draw, and stops drawing', async () => {
    mockDraw.mockImplementation(() => {
      throw new Error('GL error');
    });
    const { failures } = await mount();
    await runFrame(1000);
    expect(screen.getByTestId('ks-space-simple')).toBeTruthy();
    expect(failures).toEqual(['render-failed']);
    await runFrame(1100);
    expect(mockDraw).toHaveBeenCalledTimes(1);
  });

  it('puts a label view over each projected point, a 44 px target', async () => {
    await mount({ reducedMotion: true });
    expect(screen.getByRole('button', { name: 'Sample system, a system' })).toBeTruthy();
  });
});
