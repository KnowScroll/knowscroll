import { act } from 'react';
import { createRoot } from 'test-renderer';
import type { PartDrag } from './part-gesture';
import { PartSwipe } from './part-swipe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handlers = Record<string, (event: unknown) => void>;
const touch = (x: number, y: number) => ({ clientX: x, clientY: y });

/** Renders the swipe surface and gives its touch handlers, called as the browser would (web, jsdom). */
function surface() {
  const drags: PartDrag[] = [];
  const moves: string[] = [];
  const root = createRoot();
  act(() => {
    root.render(
      <PartSwipe onMove={(move) => moves.push(move)} onDrag={(drag) => drags.push(drag)}>
        {null}
      </PartSwipe>,
    );
  });
  const node = root.container.queryAll((candidate) => candidate.props['data-testid'] === 'part-swipe')[0];
  if (node === undefined) throw new Error('the swipe surface is drawn');
  const handlers = node.props as unknown as Handlers;
  const target = document.createElement('div');
  const at = (name: string, event: Record<string, unknown>) => {
    act(() => handlers[name]!({ target, currentTarget: target, ...event }));
  };
  return { drags, moves, at };
}

describe('a drag on the text, as the browser reports it (web)', () => {
  it('shows a sideways drag as it goes and ends it with the move it meant', () => {
    const { drags, moves, at } = surface();
    at('onTouchStart', { touches: [touch(300, 400)] });
    at('onTouchMove', { touches: [touch(200, 402)] });
    expect(drags.at(-1)).toEqual({ kind: 'part', dx: -100 });
    at('onTouchEnd', { changedTouches: [touch(200, 402)] });
    expect(moves).toEqual(['next-part']);
    expect(drags.at(-1)).toEqual({ kind: 'end', move: 'next-part' });
  });

  it('puts away what a drag showed when a second finger lands, so no panel is left over the text', () => {
    const { drags, moves, at } = surface();
    at('onTouchStart', { touches: [touch(300, 400)] });
    at('onTouchMove', { touches: [touch(260, 401)] });
    expect(drags.at(-1)).toEqual({ kind: 'part', dx: -40 });
    at('onTouchStart', { touches: [touch(260, 401), touch(100, 100)] });
    expect(drags.at(-1)).toEqual({ kind: 'end', move: undefined });
    // The lifts that follow move nothing and end nothing twice.
    at('onTouchEnd', { changedTouches: [touch(100, 100)] });
    at('onTouchEnd', { changedTouches: [touch(260, 401)] });
    expect(moves).toEqual([]);
    expect(drags.filter((drag) => drag.kind === 'end')).toHaveLength(1);
  });

  it('puts it away too when a second finger joins during the move, and when the touch is cancelled', () => {
    const first = surface();
    first.at('onTouchStart', { touches: [touch(300, 400)] });
    first.at('onTouchMove', { touches: [touch(250, 400)] });
    first.at('onTouchMove', { touches: [touch(250, 400), touch(10, 10)] });
    expect(first.drags.at(-1)).toEqual({ kind: 'end', move: undefined });
    const second = surface();
    second.at('onTouchStart', { touches: [touch(300, 400)] });
    second.at('onTouchMove', { touches: [touch(250, 400)] });
    second.at('onTouchCancel', {});
    expect(second.drags.at(-1)).toEqual({ kind: 'end', move: undefined });
  });
});
