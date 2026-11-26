import { act, render } from '@testing-library/react-native';
import { useEffect as mockUseEffect } from 'react';
import { StyleSheet } from 'react-native';
import type { SpaceCanvasProps } from '../space/space-canvas-props';
import { crossingFrame } from './crossing-frame';
import { CrossingStage } from './crossing-stage';

// The real stage. Only the GPU side is a stand-in (a canvas host that reports a surface, and a renderer that records
// what it is told): no WebGL is claimed here. The browser proves the pixels (e2e/space-gallery.spec.ts).
let mockHostProps: SpaceCanvasProps | null = null;
jest.mock('../space/space-canvas', () => ({
  SpaceCanvas: (props: SpaceCanvasProps) => {
    mockHostProps = props;
    mockUseEffect(() => {
      props.onSurface(mockSurface);
      // The host reports once per mount.
    }, []);
    return null;
  },
}));
jest.mock('./crossing-marks', () => ({ CrossingMarks: () => null }));

const mockSurface = { canvas: {}, width: 390, height: 844, pixelRatio: 1 };

interface FakeRenderer {
  draw: jest.Mock;
  resize: jest.Mock;
  dispose: jest.Mock;
}
const makeRenderer = (): FakeRenderer => ({ draw: jest.fn(), resize: jest.fn(), dispose: jest.fn() });
let mockRenderers: FakeRenderer[] = [];
let mockCreate: jest.Mock;
let mockLoads: { resolve: () => void; reject: (error: unknown) => void }[] = [];
jest.mock('./load-crossing-renderer', () => ({
  // Every load waits until the test lets it through, so "arrives late" can be staged.
  loadCrossingRenderer: () =>
    new Promise((resolve, reject) => {
      mockLoads.push({ resolve: () => resolve({ createCrossingRenderer: mockCreate }), reject });
    }),
}));

const SIZE = { width: 390, height: 844 };
const FRAME = crossingFrame(0.3, 'out', { size: SIZE, friendName: 'Ravi', names: [] });
const LATER = crossingFrame(0.5, 'out', { size: SIZE, friendName: 'Ravi', names: [] });
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
/** Lets the nth waiting load through. */
const release = async (index: number) => {
  mockLoads[index]!.resolve();
  await settle();
};

beforeEach(() => {
  mockHostProps = null;
  mockRenderers = [];
  mockLoads = [];
  mockCreate = jest.fn(() => {
    const made = makeRenderer();
    mockRenderers.push(made);
    return made;
  });
});

const view = (frame = FRAME, extra: Partial<Parameters<typeof CrossingStage>[0]> = {}) => (
  <CrossingStage frame={frame} size={SIZE} behindSeed="you" aheadSeed="friend:Ravi" {...extra} />
);

describe('the crossing stage', () => {
  it('loads the renderer on the first surface, then draws the frame and says so', async () => {
    const onDrawn = jest.fn();
    await render(view(FRAME, { onDrawn }));
    expect(mockCreate).not.toHaveBeenCalled();
    await release(0);
    expect(mockCreate).toHaveBeenCalledWith(mockSurface);
    expect(mockRenderers[0]!.draw).toHaveBeenCalledWith(FRAME);
    expect(onDrawn).toHaveBeenCalledWith(FRAME);
  });

  it('draws the next frame on the same renderer', async () => {
    const screen = await render(view(FRAME));
    await release(0);
    await screen.rerender(view(LATER));
    expect(mockRenderers).toHaveLength(1);
    expect(mockRenderers[0]!.draw).toHaveBeenLastCalledWith(LATER);
  });

  it('draws the latest frame again after a resize, which clears the buffer', async () => {
    const screen = await render(view(FRAME));
    await release(0);
    await screen.rerender(view(LATER));
    mockRenderers[0]!.draw.mockClear();
    await act(() => mockHostProps!.onResize(320, 600));
    expect(mockRenderers[0]!.resize).toHaveBeenCalledWith(320, 600);
    expect(mockRenderers[0]!.draw).toHaveBeenCalledWith(LATER);
  });

  it('never makes a renderer for a load that arrives after the stage has gone', async () => {
    const screen = await render(view());
    await screen.unmount();
    await release(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps only the newest surface: an older load that arrives late is dropped', async () => {
    await render(view());
    await act(() => mockHostProps!.onSurface(mockSurface));
    expect(mockLoads).toHaveLength(2);
    await release(1);
    await release(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRenderers[0]!.draw).toHaveBeenCalledWith(FRAME);
  });

  it('releases the old renderer, without its context, when a new surface comes, and draws only on the new one', async () => {
    const screen = await render(view());
    await release(0);
    await act(() => mockHostProps!.onSurface(mockSurface));
    expect(mockRenderers[0]!.dispose).toHaveBeenCalledWith();
    mockRenderers[0]!.draw.mockClear();
    await screen.rerender(view(LATER));
    expect(mockRenderers[0]!.draw).not.toHaveBeenCalled();
    await release(1);
    expect(mockRenderers[1]!.draw).toHaveBeenCalledWith(LATER);
  });

  it('frees the GPU context for good when it unmounts', async () => {
    const screen = await render(view());
    await release(0);
    await screen.unmount();
    expect(mockRenderers[0]!.dispose).toHaveBeenCalledWith({ releaseContext: true });
  });

  it('tells the owner when the renderer cannot be made, and keeps drawing the marks', async () => {
    const onFailure = jest.fn();
    mockCreate.mockImplementation(() => {
      throw new Error('Error creating WebGL context.');
    });
    const screen = await render(view(FRAME, { onFailure }));
    await release(0);
    expect(onFailure).toHaveBeenCalledWith('context-creation-failed', 'Error creating WebGL context.');
    expect(screen.getByTestId('ks-crossing-stage')).toBeTruthy();
  });

  it('tells the owner when the renderer chunk cannot be loaded', async () => {
    const onFailure = jest.fn();
    await render(view(FRAME, { onFailure }));
    mockLoads[0]!.reject(new Error('Loading chunk failed'));
    await settle();
    expect(onFailure).toHaveBeenCalledWith('context-creation-failed', 'Loading chunk failed');
  });

  it('says nothing about a load that fails after the stage has gone', async () => {
    const onFailure = jest.fn();
    const screen = await render(view(FRAME, { onFailure }));
    await screen.unmount();
    mockLoads[0]!.reject(new Error('Loading chunk failed'));
    await settle();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('tells the owner when a draw throws, and does not say the frame was drawn', async () => {
    const onFailure = jest.fn();
    const onDrawn = jest.fn();
    mockCreate.mockImplementation(() => {
      const made = makeRenderer();
      made.draw.mockImplementation(() => {
        throw new Error('GL error');
      });
      mockRenderers.push(made);
      return made;
    });
    await render(view(FRAME, { onFailure, onDrawn }));
    await release(0);
    expect(onFailure).toHaveBeenCalledWith('render-failed', 'GL error');
    expect(onDrawn).not.toHaveBeenCalled();
  });

  it('passes on the canvas host failing (no WebGL, or a lost context)', async () => {
    const onFailure = jest.fn();
    await render(view(FRAME, { onFailure }));
    await act(() => mockHostProps!.onFailure('context-lost'));
    expect(onFailure).toHaveBeenCalledWith('context-lost', undefined);
  });

  it('moves the whole picture by the frame shake', async () => {
    const shaken = { ...FRAME, shake: { x: 3, y: -2 } };
    const screen = await render(view(shaken));
    const style = StyleSheet.flatten(screen.getByTestId('ks-crossing-shaken').props.style) as {
      transform: Record<string, number>[];
    };
    expect(style.transform).toEqual([{ translateX: 3 }, { translateY: -2 }]);
  });
});
