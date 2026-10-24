interface KeyEvent {
  readonly nativeEvent: unknown;
  preventDefault(): void;
}

/**
 * Space presses a control that is a checkbox, radio or switch, as it does a button. React Native
 * Web gives those roles Enter but reserves Space for button roles, so a keyboard user could not
 * tick a box. Spread the result on the `Pressable`; holding the key does not repeat the press, and a
 * disabled control ignores it.
 */
export function spaceActivates(activate: () => void, disabled = false): object {
  return {
    onKeyDown: (event: KeyEvent) => {
      const key = event.nativeEvent as { key?: string; repeat?: boolean };
      if (key.key !== ' ') return;
      // A disabled control is not pressed, but Space must not scroll the page from it either.
      if (disabled) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (key.repeat !== true) activate();
    },
  };
}
