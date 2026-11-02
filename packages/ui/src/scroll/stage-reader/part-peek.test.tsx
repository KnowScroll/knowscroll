import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated } from 'react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { PartArrivalBar, PartBackTab } from './part-arrival';
import { notePartSwipeCommitted, partSwipeJustCommitted } from './part-handoff';
import { PartEdgePeek } from './part-edge-peek';
import { PartPeekPanel } from './part-peek';
import { StageReader } from './stage-reader';

const document = seasons as unknown as ScrollDocumentV2;
const two = { label: 'Part 2', title: 'Why the halves take turns', onPress: jest.fn() };
const wrap = (node: React.ReactNode, reducedMotion = true) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion }}>{node}</DisplayProvider>
);

describe('the Part a drag brings in (V3 G2, E1)', () => {
  it('says keep going before the notch and "past the notch" after it, with the Part it would open', async () => {
    const dx = new Animated.Value(-30);
    const view = await render(wrap(<PartPeekPanel side="next" peek={two} dx={dx} width={390} past={false} />));
    expect(screen.getByTestId('part-peek-words', { includeHiddenElements: true })).toHaveTextContent(
      'KEEP GOING · PART 2',
    );
    expect(screen.getByText('Why the halves take turns', { includeHiddenElements: true })).toBeOnTheScreen();
    await view.rerender(wrap(<PartPeekPanel side="next" peek={two} dx={dx} width={390} past />));
    expect(screen.getByTestId('part-peek-words', { includeHiddenElements: true })).toHaveTextContent(
      'PAST THE NOTCH · LET GO TO CONTINUE',
    );
  });

  it('is hidden from assistive technology and takes no press: the move is the button, the key and the swipe', async () => {
    await render(
      wrap(<PartPeekPanel side="previous" peek={two} dx={new Animated.Value(40)} width={390} past={false} />),
    );
    const panel = screen.getByTestId('part-peek-panel', { includeHiddenElements: true });
    expect(panel.props['aria-hidden']).toBe(true);
    expect(panel.props.pointerEvents).toBe('none');
  });
});

describe('arriving at the next Part (V3 G2, F11)', () => {
  it('says where the place in the Part before went, and goes after a few seconds', async () => {
    jest.useFakeTimers();
    try {
      await render(wrap(<PartArrivalBar arrival={{ part: 'Part 2', from: 'Part 1' }} />));
      expect(screen.getByTestId('part-arrival')).toHaveTextContent('Part 2 · your place in Part 1 is kept');
      await act(() => {
        jest.advanceTimersByTime(4_100);
      });
      expect(screen.queryByTestId('part-arrival')).not.toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  it('has a tab back to the Part before, named for where it goes', async () => {
    const onPress = jest.fn();
    await render(wrap(<PartBackTab previous={{ label: 'Part 1', title: 'It leans', onPress }} />));
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Part 1: It leans' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('draws the bar and the tab on the reader only when there is something to say, the tab only on the first stop', async () => {
    const view = await render(wrap(<StageReader document={document} commands={{}} />));
    expect(screen.queryByTestId('part-back-tab')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('part-arrival')).not.toBeOnTheScreen();
    await view.rerender(
      wrap(
        <StageReader
          document={document}
          commands={{}}
          previousPart={{ label: 'Part 1', title: 'It leans', onPress: jest.fn() }}
          arrival={{ part: 'Part 2', from: 'Part 1' }}
        />,
      ),
    );
    expect(screen.getByTestId('part-back-tab')).toBeOnTheScreen();
    expect(screen.getByTestId('part-arrival')).toBeOnTheScreen();
  });

  it('remembers that a swipe has just moved, so the Part that opens does not slide in a second time', () => {
    notePartSwipeCommitted();
    expect(partSwipeJustCommitted()).toBe(true);
  });
});

describe('the pull from the end (V3 G3)', () => {
  it('draws the handle with its meter at the top of the end tray when a new topic can be asked for', async () => {
    await render(wrap(<StageReader document={document} commands={{ nextTopic: jest.fn() }} />));
    expect(screen.getByTestId('pull-handle', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByTestId('pull-meter-fill', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('KEEP PULLING · NEXT TOPIC', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('draws no handle where there is no new topic to pull to', async () => {
    await render(wrap(<StageReader document={document} commands={{}} />));
    expect(screen.queryByTestId('pull-handle', { includeHiddenElements: true })).not.toBeOnTheScreen();
  });
});

describe('the next Part peeking in from the edge at the end (V3 F10, E1)', () => {
  it('is a tab named for the Part it continues to, and does what the dock does', async () => {
    const onPress = jest.fn();
    await render(wrap(<PartEdgePeek peek={{ ...two, onPress }} top={60} />));
    const tab = screen.getByRole('button', { name: 'Continue Part 2' });
    expect(tab).toHaveTextContent('PART 2');
    await fireEvent.press(tab);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
