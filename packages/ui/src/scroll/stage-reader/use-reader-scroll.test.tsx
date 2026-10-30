import { act, renderHook } from '@testing-library/react-native';
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

describe('a section that grows while the reader is jumping', () => {
  const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } }) as never;

  async function threeSections() {
    const scrollTo = jest.fn();
    const scroller = { current: { scrollTo } as unknown as ScrollViewInstance };
    const hook = await renderHook(() =>
      useReaderScroll({ scroller, sections: 3, startAt: 0, reducedMotion: true, onPullPastEnd: undefined }),
    );
    await act(() => {
      for (const index of [0, 1, 2]) hook.result.current.measureSection(index)(layout(100));
    });
    return { hook, scrollTo };
  }

  it('repeats the jump to the new top, so it does not land short of the stop', async () => {
    const { hook, scrollTo } = await threeSections();
    await act(() => {
      hook.result.current.jump(2, true);
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 200, animated: false });
    // The first section's answer is shown: the second and third sections move down by 50.
    await act(() => {
      hook.result.current.measureSection(0)(layout(150));
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 250, animated: false });
  });

  it('leaves the reader where they are once the jump is over', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const { hook, scrollTo } = await threeSections();
      await act(() => {
        hook.result.current.jump(2, true);
      });
      scrollTo.mockClear();
      jest.setSystemTime(1_005_000);
      await act(() => {
        hook.result.current.measureSection(0)(layout(150));
      });
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
