import type { GestureResponderEvent } from 'react-native';

export interface LinkTarget {
  readonly href?: string;
  readonly onNavigate: () => void;
}

export interface LinkPress {
  readonly onPress: (event: GestureResponderEvent) => void;
}

/** The parts of the browser click event a link needs (React Native Web passes the DOM click). */
interface ClickLike {
  readonly defaultPrevented?: boolean;
  readonly button?: number;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  preventDefault?: () => void;
}

/**
 * Web: with an `href`, React Native Web renders a real `<a href>`, so Enter, middle-click and
 * "open in new tab" are the browser's own. A plain primary click (or Enter) is taken over for
 * client-side navigation; a modified click (Ctrl/Cmd/Shift/Alt) or another button is left to
 * the browser, which opens the address elsewhere.
 */
export function linkPress({ href, onNavigate }: LinkTarget): LinkPress {
  if (href === undefined) return { onPress: () => onNavigate() };
  const props = {
    href,
    onPress: (event: GestureResponderEvent) => {
      const click = event as unknown as ClickLike;
      if (click.defaultPrevented === true) return;
      if ((click.button ?? 0) !== 0 || click.metaKey === true || click.ctrlKey === true) return;
      if (click.shiftKey === true || click.altKey === true) return;
      click.preventDefault?.();
      onNavigate();
    },
  };
  return props;
}
