import { useFocusRing } from '../../display/focus-ring';
import { usePagePalette } from '../page/page-palette';
import { underlineOf } from './phrase-underline';
import type { BeatLink } from './reading-model';

/**
 * `dataSet` (what `useFocusRing` hands React Native Web) as the `data-*` attributes it becomes, for an element React
 * Native Web does not draw: `ksFocus` is `data-ks-focus`, which the focus-ring stylesheet matches on `:focus-visible`.
 */
function dataAttributes(props: object): Record<string, string> {
  const dataSet = (props as { dataSet?: Readonly<Record<string, string>> }).dataSet ?? {};
  return Object.fromEntries(
    Object.entries(dataSet).map(([name, value]) => [
      `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    ]),
  );
}

/**
 * Web: one linked phrase as a plain inline `<span role="button">`, so it wraps with its paragraph like any other words.
 * A React Native `Text` with the button role is drawn as a real `<button>`, one box that never breaks across lines: a
 * phrase that did not fit went to the next line whole, with the words after it on another (#794). A span has the same
 * promises by hand: it is named, reached by Tab, pressed by a click, Enter or Space (not repeated, and Space does not
 * scroll the page), underlined in its part's colour, and drawn with the web's focus ring. It stays in the paragraph's
 * ink by inheriting it.
 */
export function LinkedPhrase({ link, onPress }: { readonly link: BeatLink; readonly onPress: (part: string) => void }) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  const press = () => onPress(link.part);
  return (
    <span
      {...dataAttributes(focus.props)}
      role="button"
      tabIndex={0}
      aria-label={`Show ${link.phrase} in the picture`}
      onClick={(event) => {
        // A press here is the phrase's alone, as it is for a React Native Web `Text` with `onPress`.
        event.stopPropagation();
        press();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        // Space would otherwise scroll the page; a held key must not press again and again.
        event.preventDefault();
        if (!event.repeat) press();
      }}
      style={{
        textDecoration: 'underline',
        textDecorationColor: underlineOf(link, page.link),
        cursor: 'pointer',
      }}
    >
      {link.phrase}
    </span>
  );
}
