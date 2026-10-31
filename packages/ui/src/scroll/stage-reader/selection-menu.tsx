/**
 * Native: the platform's own selection menu cannot be given items from here, so there is no menu on a phone's text.
 * "Simpler" is in the ••• menu and on each stop, and a Quick answer is reached from there too (D-244).
 */
export function SelectionMenu(_props: {
  readonly onSimpler: (stopId: string) => void;
  readonly onAsk: (stopId: string, selected: string) => void;
}): null {
  return null;
}
