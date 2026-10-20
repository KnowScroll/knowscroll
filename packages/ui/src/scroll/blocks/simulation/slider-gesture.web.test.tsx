/**
 * The web slider's pointer rule (jest-expo/web): the horizontal axis locks after the slop, the
 * slider captures the pointer and owns the drag until release; a vertical movement is left to the
 * page; a tap jumps; a cancelled pointer keeps nothing. The browser's own touch-action is covered
 * by the Playwright smoke over the gallery export.
 */
import { act } from 'react';
import { createRoot, type Root } from 'test-renderer';
import { pendulumSimulation } from '../../fixtures/blocks';
import { useSliderGesture, type SliderGesture, type SliderGestureInput } from './slider-gesture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pendulumParam() {
  const found = pendulumSimulation('sim-test').data.params[0];
  if (found === undefined) throw new Error('the pendulum has a parameter');
  return found;
}

const param = pendulumParam();

function Probe({ input, onGesture }: { input: SliderGestureInput; onGesture: (gesture: SliderGesture) => void }) {
  onGesture(useSliderGesture(input));
  return null;
}

type Handler = (event: unknown) => void;

function setup() {
  const input = {
    param,
    travel: 300,
    inset: 16,
    onPreview: jest.fn(),
    onCommit: jest.fn(),
    onDragging: jest.fn(),
  } satisfies SliderGestureInput;
  let gesture: SliderGesture | null = null;
  const root: Root = createRoot();
  act(() =>
    root.render(
      <Probe
        input={input}
        onGesture={(next) => {
          gesture = next;
        }}
      />,
    ),
  );
  if (gesture === null) throw new Error('the hook returned nothing');
  const props = (gesture as SliderGesture).viewProps as Record<string, Handler | { touchAction: string }>;
  const element = { getBoundingClientRect: () => ({ left: 0 }), setPointerCapture: jest.fn() };
  const at = (x: number, y: number, id = 1) => ({
    pointerId: id,
    clientX: x,
    clientY: y,
    currentTarget: element,
    preventDefault: jest.fn(),
  });
  const fire = (name: 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel', event: unknown) =>
    (props[name] as Handler)(event);
  return { input, props, element, at, fire, root };
}

describe('the web slider gesture', () => {
  it('locks the horizontal axis after the slop, captures the pointer, previews live and commits on release', () => {
    const { input, element, at, fire, root } = setup();

    fire('onPointerDown', at(100, 20));
    fire('onPointerMove', at(104, 22));
    expect(element.setPointerCapture).not.toHaveBeenCalled();
    expect(input.onPreview).not.toHaveBeenCalled();

    const move = at(130, 24);
    fire('onPointerMove', move);
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(input.onDragging).toHaveBeenCalledWith(true);
    expect(input.onPreview).toHaveBeenLastCalledWith(1.75);
    expect(move.preventDefault).toHaveBeenCalled();

    fire('onPointerUp', at(130, 24));
    expect(input.onDragging).toHaveBeenLastCalledWith(false);
    expect(input.onCommit).toHaveBeenCalledWith(1.75, true);
    act(() => root.unmount());
  });

  it('leaves a vertical movement to the page: no capture, no preview, nothing kept', () => {
    const { input, element, at, fire, root } = setup();

    fire('onPointerDown', at(100, 20));
    fire('onPointerMove', at(102, 40));
    fire('onPointerMove', at(160, 60));
    fire('onPointerUp', at(160, 60));

    expect(element.setPointerCapture).not.toHaveBeenCalled();
    expect(input.onPreview).not.toHaveBeenCalled();
    expect(input.onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('jumps to where a tap lands (and says it was a tap, not a drag)', () => {
    const { input, at, fire, root } = setup();

    fire('onPointerDown', at(200, 20));
    fire('onPointerUp', at(200, 20));

    expect(input.onCommit).toHaveBeenCalledWith(2.5, false);
    expect(input.onDragging).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('keeps nothing when the browser takes the touch back for scrolling (pointercancel)', () => {
    const { input, at, fire, root } = setup();

    fire('onPointerDown', at(100, 20));
    fire('onPointerMove', at(140, 22));
    fire('onPointerCancel', at(140, 22));
    fire('onPointerUp', at(140, 22));

    expect(input.onDragging).toHaveBeenLastCalledWith(false);
    expect(input.onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('ignores a second pointer while one is down', () => {
    const { input, at, fire, root } = setup();

    fire('onPointerDown', at(100, 20, 1));
    fire('onPointerMove', at(150, 20, 2));

    expect(input.onPreview).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('asks the browser to keep vertical panning: touch-action pan-y', () => {
    const { props, root } = setup();
    expect(props['style']).toEqual({ touchAction: 'pan-y' });
    act(() => root.unmount());
  });
});
