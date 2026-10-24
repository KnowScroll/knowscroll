interface KeyEvent {
  readonly nativeEvent: unknown;
  preventDefault(): void;
}

/**
 * Space presses a control that is a checkbox, radio or switch, as it does a button. React Native
 * Web gives those roles Enter but reserves Space for button roles, so a keyboard user could not
 * tick a box. Spread the result on the `Pressable`; holding the key does not repeat the press.
 */
export function spaceActivates(activate: () => void): object {
  return {
    onKeyDown: (event: KeyEvent) => {
      const key = event.nativeEvent as { key?: string; repeat?: boolean };
      if (key.key !== ' ') return;
      event.preventDefault();
      if (key.repeat !== true) activate();
    },
  };
}
