import { Text as NativeText } from 'react-native';
import { useFocusRing } from '../../display/focus-ring';
import { usePagePalette } from '../page/page-palette';
import { underlineOf } from './phrase-underline';
import type { BeatLink } from './reading-model';

interface KeyEvent {
  readonly nativeEvent: unknown;
  preventDefault(): void;
}

/**
 * What makes a phrase reachable and pressable from a keyboard (a switch, a keyboard on a tablet). A span with the button
 * role is neither focusable nor pressed by Enter or Space there, and the reader's own keys act only while the reader
 * itself has focus, so Space here does not scroll. The props are not in React Native's types for a Text.
 */
function keyboardProps(press: () => void): object {
  return {
    focusable: true,
    tabIndex: 0,
    onKeyDown: (event: KeyEvent) => {
      const key = event.nativeEvent as { key?: string; repeat?: boolean };
      if (key.key !== 'Enter' && key.key !== ' ') return;
      event.preventDefault();
      if (key.repeat !== true) press();
    },
  };
}

/**
 * Native: one linked phrase, an inline button underlined in the text's own colour. The web draws it as a plain span
 * instead (`linked-phrase.web.tsx`), because a `Text` with the button role becomes a `<button>` there. Folio is not
 * shipped on native yet (#740), and a native inline text could not draw a view's focus outline anyway.
 */
export function LinkedPhrase({ link, onPress }: { readonly link: BeatLink; readonly onPress: (part: string) => void }) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  const press = () => onPress(link.part);
  return (
    <NativeText
      {...focus.props}
      {...keyboardProps(press)}
      role="button"
      accessibilityRole="button"
      accessibilityLabel={`Show ${link.phrase} in the picture`}
      onPress={press}
      style={{ textDecorationLine: 'underline', textDecorationColor: underlineOf(link, page.link) }}
    >
      {link.phrase}
    </NativeText>
  );
}
