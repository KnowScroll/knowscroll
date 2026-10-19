import type { GestureResponderEvent } from 'react-native';

export interface LinkTarget {
  /** Where the control goes; on the web it becomes a real `<a href>`. */
  readonly href?: string;
  /** Client-side navigation (the router). */
  readonly onNavigate: () => void;
}

export interface LinkPress {
  readonly onPress: (event: GestureResponderEvent) => void;
}

/** Native: a press navigates; there is no address to open elsewhere. */
export function linkPress({ onNavigate }: LinkTarget): LinkPress {
  return { onPress: () => onNavigate() };
}
