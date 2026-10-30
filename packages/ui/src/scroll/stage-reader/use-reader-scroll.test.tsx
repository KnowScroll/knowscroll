import { renderHook } from '@testing-library/react-native';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native';
import { useReaderScroll } from './use-reader-scroll';

const event = (offset: number, viewport = 400, content = 1000): NativeSyntheticEvent<NativeScrollEvent> =>
  ({
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      layoutMeasurement: { width: 390, height: viewport },
      contentSize: { width: 390, height: content },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>;

async function reader(onPullPastEnd: () => void) {
  const scroller = { current: null as ScrollViewInstance | null };
  const hook = await renderHook(() =>
    useReaderScroll({ scroller, sections: 3, startAt: 0, reducedMotion: true, onPullPastEnd }),
  );
  const props = hook.result.current.scrollProps;
  props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 400 } } } as never);
  props.onContentSizeChange?.(390, 1000);
  return props;
}

describe('a pull past the end of the text on a phone', () => {
  it('asks for a new topic when the drag began at the end and went 72 px past it', async () => {
    const asked = jest.fn();
    const props = await reader(asked);
    props.onScroll?.(event(600));
    props.onScrollBeginDrag?.(event(600));
    props.onScrollEndDrag?.(event(672));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('does not when the drag began mid-text and ended past the end: that is a fling, and reading', async () => {
    const asked = jest.fn();
    const props = await reader(asked);
    props.onScroll?.(event(300));
    props.onScrollBeginDrag?.(event(300));
    props.onScrollEndDrag?.(event(690));
    expect(asked).not.toHaveBeenCalled();
  });

  it('does not for a short pull, and a later drag does not inherit an earlier start', async () => {
    const asked = jest.fn();
    const props = await reader(asked);
    props.onScroll?.(event(600));
    props.onScrollBeginDrag?.(event(600));
    props.onScrollEndDrag?.(event(640));
    props.onScrollEndDrag?.(event(700));
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('a reveal, brought on screen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Three sections of 300 px laid out in a 400 px view; the scroller records where it is told to go. */
  async function layOut() {
    const scrollTo = jest.fn();
    const scroller = { current: { scrollTo } as unknown as ScrollViewInstance };
    const hook = await renderHook(() =>
      useReaderScroll({ scroller, sections: 3, startAt: 0, reducedMotion: true, onPullPastEnd: undefined }),
    );
    const { scrollProps, measureSection, revealIn, reportReveal } = hook.result.current;
    scrollProps.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 400 } } } as never);
    const measure = (index: number, height: number) =>
      measureSection(index)({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } } as never);
    measure(0, 300);
    measure(1, 300);
    measure(2, 300);
    return { scrollTo, measure, revealIn, reportReveal, scrollProps };
  }

  it('shows the end of a reveal that fits the view, once the section has grown to hold it', async () => {
    const { scrollTo, measure, revealIn, reportReveal, scrollProps } = await layOut();
    scrollProps.onScroll?.(event(300, 400, 900));
    revealIn(1);
    measure(1, 520);
    reportReveal(1, 250);
    jest.advanceTimersByTime(100);
    // Section 1 now ends at 300 + 520 = 820; a 400 px view shows its end from 420, and the 250 px reveal is all in it.
    expect(scrollTo).toHaveBeenCalledWith({ y: 420, animated: false });
  });

  it('shows the start of a reveal that is taller than the view, so its label is what is seen first', async () => {
    const { scrollTo, measure, revealIn, reportReveal, scrollProps } = await layOut();
    scrollProps.onScroll?.(event(300, 400, 900));
    revealIn(1);
    measure(1, 700);
    reportReveal(1, 520);
    jest.advanceTimersByTime(100);
    // The section ends at 1000; the reveal (with its padding) starts at 480, above the 600 that shows the end.
    expect(scrollTo).toHaveBeenCalledWith({ y: 480, animated: false });
  });

  it('does not scroll when the reveal is already on screen, or scroll back up', async () => {
    const { scrollTo, measure, revealIn, reportReveal, scrollProps } = await layOut();
    scrollProps.onScroll?.(event(500, 400, 900));
    revealIn(1);
    measure(1, 320);
    reportReveal(1, 200);
    jest.advanceTimersByTime(100);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('answers a lock once, and only for the section it was told about', async () => {
    const { scrollTo, measure, revealIn, reportReveal, scrollProps } = await layOut();
    scrollProps.onScroll?.(event(0, 400, 900));
    revealIn(1);
    measure(1, 520);
    reportReveal(2, 200);
    jest.advanceTimersByTime(100);
    expect(scrollTo).not.toHaveBeenCalled();
    reportReveal(1, 250);
    jest.advanceTimersByTime(100);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    reportReveal(1, 250);
    jest.advanceTimersByTime(100);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('forgets a lock whose reveal never arrived', async () => {
    const { scrollTo, measure, revealIn, reportReveal, scrollProps } = await layOut();
    scrollProps.onScroll?.(event(0, 400, 900));
    revealIn(1);
    measure(1, 520);
    jest.advanceTimersByTime(5_000);
    reportReveal(1, 250);
    jest.advanceTimersByTime(100);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
