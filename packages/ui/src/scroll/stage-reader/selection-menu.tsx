/**
 * Native: the platform's own selection menu cannot be given items from here, so there is no menu on a phone's text.
 * "Simpler" is in the ••• menu and on each stop, and Ask is in the dock (D-244).
 */
export function SelectionMenu(_props: {
  readonly onSimpler: (stopId: string) => void;
  readonly onAsk?: ((stopId: string, selected: string) => void) | undefined;
}): null {
  return null;
}
