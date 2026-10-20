/**
 * The web token drag (jest-expo/web): the token owns the touch from the first contact
 * (`touch-action: none`, the pointer captured), follows the pointer in canvas units, is dropped
 * where it was released, and a cancelled pointer drops nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'test-renderer';
import { useDragGesture, type DragGesture, type DragInput } from './drag-gesture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ input, onGesture }: { input: DragInput; onGesture: (gesture: DragGesture) => void }) {
  onGesture(useDragGesture(input));
  return null;
}

type Handler = (event: unknown) => void;

function setup(enabled = true) {
  const input = {
    enabled,
    unit: 2,
    home: { x: 100, y: 150 },
    onStart: jest.fn(),
    onMove: jest.fn(),
    onDrop: jest.fn(),
    onEnd: jest.fn(),
  } satisfies DragInput;
  let gesture: DragGesture | null = null;
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
  const props = (gesture as DragGesture).viewProps as Record<string, Handler | { touchAction: string }>;
  const element = { setPointerCapture: jest.fn() };
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

describe('the web diagram drag', () => {
  it('captures the pointer at once, moves the token by the pointer’s travel in canvas units, drops it where it is released', () => {
    const { input, element, at, fire, root } = setup();

    const down = at(50, 60);
    fire('onPointerDown', down);
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(input.onStart).toHaveBeenCalledTimes(1);

    fire('onPointerMove', at(60, 70));
    expect(input.onMove).toHaveBeenLastCalledWith({ x: 120, y: 170 });
    fire('onPointerMove', at(40, 55));
    expect(input.onMove).toHaveBeenLastCalledWith({ x: 80, y: 140 });

    fire('onPointerUp', at(40, 55));
    expect(input.onDrop).toHaveBeenCalledWith({ x: 80, y: 140 });
    expect(input.onEnd).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('drops nothing when the pointer is cancelled', () => {
    const { input, at, fire, root } = setup();

    fire('onPointerDown', at(50, 60));
    fire('onPointerMove', at(70, 80));
    fire('onPointerCancel', at(70, 80));

    expect(input.onDrop).not.toHaveBeenCalled();
    expect(input.onEnd).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('does nothing where the diagram does not drag', () => {
    const { input, element, at, fire, root } = setup(false);

    fire('onPointerDown', at(50, 60));
    fire('onPointerMove', at(70, 80));
    fire('onPointerUp', at(70, 80));

    expect(element.setPointerCapture).not.toHaveBeenCalled();
    expect(input.onStart).not.toHaveBeenCalled();
    expect(input.onDrop).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('owns the touch from the first contact: touch-action none', () => {
    const { props, root } = setup();
    expect(props['style']).toEqual({ touchAction: 'none' });
    act(() => root.unmount());
  });
});
