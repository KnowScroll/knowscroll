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
