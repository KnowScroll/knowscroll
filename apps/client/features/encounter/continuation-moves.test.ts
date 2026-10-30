import type { ContinuationState } from '@knowscroll/contracts';
import { readerContinuations } from './continuation-moves';
import type { ReadyContinuation } from './continuation-intent';

const target = { assetId: '0199a000-0000-7000-8000-000000000301', assetRevision: 1 };
const series = { seriesId: 'ci-series', seriesRevision: 1 };
const metadata = (title: string) => ({ kind: 'scroll' as const, title, summary: 'CI link', language: 'en' });
const partTwo = {
  status: 'ready',
  linkId: '0199a000-0000-7000-8000-000000000701',
  target,
  metadata: metadata('The second Part'),
  relation: { kind: 'series_step', ...series, part: 2 },
} satisfies ContinuationState;
const partZero = {
  ...partTwo,
  linkId: '0199a000-0000-7000-8000-000000000702',
  metadata: metadata('The first Part'),
  relation: { kind: 'series_step', ...series, part: 1 },
} satisfies ContinuationState;
const related = {
  status: 'ready',
  linkId: '0199a000-0000-7000-8000-000000000801',
  target,
  metadata: metadata('Another angle'),
  relation: { kind: 'related_move', label: 'CI related angle' },
} satisfies ContinuationState;
const pending = { status: 'pending', requestId: '0199a000-0000-7000-8000-000000000901' } satisfies ContinuationState;
const none = { status: 'unavailable', reason: 'series_boundary' } satisfies ContinuationState;

describe('the moves a reader offers from what the server admitted', () => {
  it('has a move for each ready continuation, named for where it goes', () => {
    const go = jest.fn<void, [ReadyContinuation, 'next' | 'previous']>();
    const moves = readerContinuations({ seriesPrevious: partZero, seriesNext: partTwo, related }, go);
    expect(moves.nextPart).toMatchObject({ label: 'Part 2', title: 'The second Part' });
    expect(moves.related).toMatchObject({ label: 'Related', title: 'Another angle' });
    moves.nextPart?.onPress();
    moves.related?.onPress();
    moves.previousPart?.();
    expect(go.mock.calls.map(([state, direction]) => [state.linkId, direction])).toEqual([
      [partTwo.linkId, 'next'],
      [related.linkId, 'next'],
      [partZero.linkId, 'previous'],
    ]);
  });

  it('has no move for a continuation that was not admitted, so no button, key or swipe reaches it', () => {
    const moves = readerContinuations(
      { seriesPrevious: none, seriesNext: none, related: { status: 'unavailable', reason: 'no_related_ready' } },
      jest.fn(),
    );
    expect(moves).toEqual({ nextPart: undefined, related: undefined, previousPart: undefined });
  });

  it('has no move while a continuation is still being prepared', () => {
    const moves = readerContinuations({ seriesPrevious: none, seriesNext: pending, related: pending }, jest.fn());
    expect(moves.nextPart).toBeUndefined();
    expect(moves.related).toBeUndefined();
  });
});
