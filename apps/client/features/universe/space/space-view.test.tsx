import { act, render, screen } from '@testing-library/react-native';
import { StrictMode, useEffect as mockUseEffect } from 'react';
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
let mockHostProps: SpaceCanvasProps | null = null;
jest.mock('./space-canvas', () => {
  return {
    SpaceCanvas: (props: SpaceCanvasProps) => {
      mockHostProps = props;
      mockUseEffect(() => {
        mockHost(props);
      }, []);
      return null;
    },
  };
});

interface MockRenderer {
  draw: jest.Mock<void, [number]>;
  dispose: jest.Mock;
}
let mockRenderers: MockRenderer[] = [];
let mockCreateFails = false;
let mockDrawFails = false;
jest.mock('./load-space-renderer', () => ({
  loadSpaceRenderer: () =>
    Promise.resolve({
      createSpaceRenderer: () => {
        if (mockCreateFails) throw new Error('Error creating WebGL context.');
        const created: MockRenderer = {
          draw: jest.fn<void, [number]>((): void => {
            if (mockDrawFails) throw new Error('GL error');
          }),
          dispose: jest.fn(),
        };
        mockRenderers.push(created);
        return {
          ...created,
          resize: jest.fn(),
          isFar: () => false,
          setCamera: jest.fn(),
          setScript: jest.fn(),
          setHighlight: jest.fn(),
          setDefinition: jest.fn(),
          anchors: () => [
            {
              id: 'sample-system',
              kind: 'system',
              name: 'Sample system',
              systemId: 'sample-system',
              x: 100,
              y: 100,
              radiusPx: 12,
              visible: true,
            },
          ],
          probe: () => ({ litPixels: 1, sampledPixels: 2, signature: 3 }),
        };
      },
    }),
}));

const surface = { canvas: {}, width: 390, height: 560, pixelRatio: 1.5 };
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const draws = (): number => mockRenderers.reduce((sum, entry) => sum + entry.draw.mock.calls.length, 0);

let frameCallbacks: ((nowMs: number) => void)[] = [];
beforeEach(() => {
  mockFocused = true;
  mockCreateFails = false;
  mockDrawFails = false;
  mockRenderers = [];
  mockHostProps = null;
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

async function mount(options: { reducedMotion?: boolean; strict?: boolean } = {}) {
  const failures: SpaceFailure[] = [];
  const view = (
    <DisplayProvider value={{ reducedMotion: options.reducedMotion ?? false }}>
      <SpaceView
        definition={SAMPLE_SPACE}
        fallback={() => <SpaceSimpleLists definition={SAMPLE_SPACE} />}
        diagnostics={{ onFrame: () => undefined, onFailure: (reason) => failures.push(reason) }}
      />
    </DisplayProvider>
  );
  const rendered = await render(options.strict === true ? <StrictMode>{view}</StrictMode> : view);
  await settle();
  return { failures, rendered };
}

describe('the space view', () => {
  it('unmounts cleanly where the platform has no memory warning to unsubscribe from (the web)', async () => {
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(((type: string) =>
        type === 'memoryWarning'
          ? undefined
          : { remove: () => undefined }) as unknown as typeof AppState.addEventListener);
    const { rendered } = await mount();
    await expect(rendered.unmount()).resolves.not.toThrow();
  });

  it('draws on a 30 fps cadence while the route is focused', async () => {
    await mount();
    await runFrame(1000);
    await runFrame(1016);
    await runFrame(1033);
    expect(draws()).toBe(2);
  });

  it('draws nothing while the route is not focused', async () => {
    mockFocused = false;
    await mount();
    expect(frameCallbacks).toHaveLength(0);
    expect(draws()).toBe(0);
  });

  it('stops its loop when the app leaves the foreground and resumes when it returns', async () => {
    let appState: (state: AppStateStatus) => void = () => undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'change') appState = listener;
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
    expect(draws()).toBe(1);
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
    mockDrawFails = true;
    const { failures } = await mount();
    await runFrame(1000);
    expect(screen.getByTestId('ks-space-simple')).toBeTruthy();
    expect(failures).toEqual(['render-failed']);
    await runFrame(1100);
    expect(draws()).toBe(1);
    expect(mockRenderers[0]!.dispose).toHaveBeenCalled();
  });

  it('shows the plain lists once when the device reports low memory', async () => {
    let memoryWarning: () => void = () => undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'memoryWarning') memoryWarning = listener;
      return { remove: jest.fn() };
    });
    const { failures } = await mount();
    await act(() => memoryWarning());
    await act(() => memoryWarning());
    expect(screen.getByTestId('ks-space-simple')).toBeTruthy();
    expect(failures).toEqual(['low-memory']);
    expect(mockRenderers[0]!.dispose).toHaveBeenCalled();
  });

  it('puts a label view over each projected point, a 44 px target', async () => {
    await mount({ reducedMotion: true });
    expect(screen.getByRole('button', { name: 'Sample system, a system' })).toBeTruthy();
  });

  describe('the surface and the view lifetime', () => {
    it('releases the old renderer and loop when the canvas makes a second surface, and draws on the new one', async () => {
      await mount();
      await runFrame(1000);
      const first = mockRenderers[0]!;
      expect(first.draw).toHaveBeenCalledTimes(1);

      await act(() => mockHostProps!.onSurface(surface));
      await settle();
      expect(mockRenderers).toHaveLength(2);
      expect(first.dispose).toHaveBeenCalled();

      await runFrame(2000);
      await runFrame(2040);
      expect(first.draw).toHaveBeenCalledTimes(1);
      expect(mockRenderers[1]!.draw.mock.calls.length).toBeGreaterThan(0);
    });

    it('a surface that arrives while the first is still loading wins', async () => {
      mockHost = () => undefined;
      await mount();
      await act(() => {
        mockHostProps!.onSurface(surface);
        mockHostProps!.onSurface(surface);
      });
      await settle();
      expect(mockRenderers).toHaveLength(1);
    });

    it('stops the loop and disposes the renderer on unmount', async () => {
      const { rendered } = await mount();
      await runFrame(1000);
      const only = mockRenderers[0]!;
      const pending = frameCallbacks;

      await rendered.unmount();
      expect(only.dispose).toHaveBeenCalledWith({ releaseContext: true });

      frameCallbacks = [];
      await act(() => pending.forEach((callback) => callback(1100)));
      expect(only.draw).toHaveBeenCalledTimes(1);
      expect(frameCallbacks).toHaveLength(0);
    });

    it('draws after a strict-mode mount (mount, cleanup, mount)', async () => {
      await mount({ strict: true });
      await runFrame(1000);
      expect(draws()).toBeGreaterThan(0);
      const live = mockRenderers.filter((entry) => entry.dispose.mock.calls.length === 0);
      expect(live).toHaveLength(1);
    });

    it('draws a reduced-motion still after a strict-mode mount', async () => {
      await mount({ strict: true, reducedMotion: true });
      expect(draws()).toBeGreaterThan(0);
    });
  });
});
