import { useEffect, useState } from 'react';
import { content, fontFallback, fontFamily } from '@knowscroll/design-tokens';

/** Where the menu sits and what it acts on: the stop the selection is in, the selected words and the middle of the first line. */
interface Selected {
  readonly stopId: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

const MENU_WIDTH = 188;
const EDGE = 8;
/** The app's UI face: a bare `<button>` does not inherit one from the page, and falls back to the browser's own serif. */
const UI_FONT = [fontFamily.text, ...fontFallback.text].join(', ');

/** The read stop a selection lies wholly inside, or nothing: a call's words are never offered a Simpler or an answer. */
export function selectedInReadStop(): Selected | undefined {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const element = anchor instanceof Element ? anchor : anchor.parentElement;
  const stop = element?.closest('[data-ks-stop]') ?? null;
  const stopId = stop?.getAttribute('data-ks-stop');
  if (stop === null || stopId === undefined || stopId === null || stop.getAttribute('data-ks-kind') !== 'read')
    return undefined;
  const text = selection.toString();
  if (text.trim() === '') return undefined;
  const rect = range.getBoundingClientRect();
  return { stopId, text, x: rect.left + rect.width / 2, y: rect.top };
}

/**
 * Web: the two items V3 D2 adds to the selection menu, "Simpler" and "Ask". A web page cannot add items to the browser's
 * own menu, so a small toolbar sits above the selected words (the same two items, in the same order) and goes when the
 * selection does. It appears only for words inside a read stop, takes no focus from the text (a press does not collapse
 * the selection) and is a toolbar to a screen reader. Nothing here calls the server (D-244).
 */
export function SelectionMenu({
  onSimpler,
  onAsk,
}: {
  readonly onSimpler: (stopId: string) => void;
  readonly onAsk?: ((stopId: string, selected: string) => void) | undefined;
}) {
  const [selected, setSelected] = useState<Selected>();
  useEffect(() => {
    const read = () => setSelected(selectedInReadStop());
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, []);
  if (selected === undefined) return null;
  const done = (act: () => void) => {
    act();
    window.getSelection()?.removeAllRanges();
    setSelected(undefined);
  };
  const items: readonly (readonly [string, () => void])[] = [
    ['Simpler', () => onSimpler(selected.stopId)],
    ...(onAsk === undefined ? [] : [['Ask', () => onAsk(selected.stopId, selected.text)] as const]),
  ];
  const left = Math.min(Math.max(selected.x - MENU_WIDTH / 2, EDGE), window.innerWidth - MENU_WIDTH - EDGE);
  return (
    <div
      role="toolbar"
      aria-label="Selected text"
      data-testid="selection-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') done(() => undefined);
      }}
      style={{
        position: 'fixed',
        zIndex: 20,
        left,
        top: Math.max(EDGE, selected.y - 52),
        width: MENU_WIDTH,
        display: 'flex',
        gap: 2,
        padding: 4,
        borderRadius: 12,
        backgroundColor: content.ink,
      }}
    >
      {items.map(([label, act]) => (
        <button
          key={label}
          type="button"
          // A press on a button would take focus and collapse the selection before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => done(act)}
          style={{
            flex: 1,
            minHeight: 44,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: content.continue,
            fontFamily: UI_FONT,
            fontSize: 15,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
