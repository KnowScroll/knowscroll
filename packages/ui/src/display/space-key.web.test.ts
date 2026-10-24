/** Web-only (jest-expo/web): Space presses a checkbox, radio or switch, which React Native Web leaves to button roles. */
import { spaceActivates } from './space-key';

type KeyHandler = (event: { nativeEvent: unknown; preventDefault: () => void }) => void;

function press(handler: KeyHandler, key: string, repeat = false) {
  const preventDefault = jest.fn();
  handler({ nativeEvent: { key, repeat }, preventDefault });
  return preventDefault;
}

describe('spaceActivates (web)', () => {
  it('activates once on Space and keeps the page from scrolling', () => {
    const activate = jest.fn();
    const { onKeyDown } = spaceActivates(activate) as { onKeyDown: KeyHandler };
    const prevented = press(onKeyDown, ' ');
    expect(activate).toHaveBeenCalledTimes(1);
    expect(prevented).toHaveBeenCalled();
  });

  it('does not repeat while the key is held, and ignores other keys', () => {
    const activate = jest.fn();
    const { onKeyDown } = spaceActivates(activate) as { onKeyDown: KeyHandler };
    press(onKeyDown, ' ', true);
    press(onKeyDown, 'Enter');
    press(onKeyDown, 'a');
    expect(activate).not.toHaveBeenCalled();
  });
});
