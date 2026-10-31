import { act } from 'react';
import { createRoot } from 'test-renderer';
import { useFocusOnMount } from './focus-on-mount';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Web: an element that appears takes focus from a script, and only when it is asked to. */
function Probe({ target, enabled }: { target: { current: { focus: () => void } }; enabled?: boolean }) {
  useFocusOnMount(target as never, enabled);
  return null;
}

describe('focusing what replaces a pressed button (web)', () => {
  it('focuses the element when it mounts, and does nothing while disabled', () => {
    const focus = jest.fn();
    const target = { current: { focus } };
    const root = createRoot();
    act(() => {
      root.render(<Probe target={target} enabled={false} />);
    });
    expect(focus).not.toHaveBeenCalled();
    act(() => {
      root.render(<Probe target={target} enabled />);
    });
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => {
      root.render(<Probe target={target} enabled />);
    });
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
