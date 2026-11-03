import { fireEvent, render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import article from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';
import { formatNoteOf, keptWords } from './format-note';
import { FormatNoteCard } from './format-note-card';

const document = seasons as unknown as ScrollDocumentV2;
const stopAt = (index: number) => document.stops[index]!.id;

/** Hand-made entries, enough for the card: not product content. */
function entry(
  relation: string,
  overrides: Record<string, unknown> = {},
  title = document.title,
): Parameters<typeof formatNoteOf>[1] {
  return {
    kind: 'scroll',
    offer: { relation: { kind: relation } },
    context: { variants: [{ kind: 'reel', status: 'ready' }] },
    scroll: { document: { ...document, title } },
    ...overrides,
  } as unknown as Parameters<typeof formatNoteOf>[1];
}

describe('the note after a new topic lands on a Scroll (V3 G4)', () => {
  it('says what was left, kept at the stop it was on, and what the new Scroll is, from the documents alone', () => {
    const left = entry('discovery', { position: { kind: 'scroll', value: { blockId: stopAt(3) } } }, 'Seasons Part 1');
    const now = entry('discovery');
    const note = formatNoteOf([left, now], now)!;
    expect(note.kicker).toBe('NEXT TOPIC · AS A SCROLL');
    expect(note.title).toBe(document.title);
    expect(note.facts).toMatch(/\d+ min · 3 calls$/);
    expect(note.kept).toEqual({ title: 'Seasons Part 1', at: 4, of: document.stops.length });
    expect(keptWords(note.kept)).toBe(`Seasons Part 1 is kept at 4 of ${String(document.stops.length)}.`);
    expect(note.canSwitchToReel).toBe(true);
  });

  it('offers no switch when the Reel of this topic is not ready, and says only that the Scroll left is kept without a place', () => {
    const left = entry('discovery');
    const now = entry('discovery', { context: { variants: [{ kind: 'reel', status: 'pending' }] } });
    const note = formatNoteOf([left, now], now)!;
    expect(note.canSwitchToReel).toBe(false);
    expect(note.kept.at).toBeUndefined();
    expect(keptWords(note.kept)).toBe(`${document.title} is kept.`);
  });

  it('is not said for the first open, a Part, a related move, a format switch, a Reel left behind or an entry no longer last', () => {
    const left = entry('discovery');
    const reel = { ...left, kind: 'reel' } as unknown as EncounterEntry;
    const now = entry('discovery');
    expect(formatNoteOf([now], now)).toBeUndefined();
    for (const relation of ['series_step', 'related_move', 'format_variant', 'return']) {
      const other = entry(relation);
      expect(formatNoteOf([left, other], other)).toBeUndefined();
    }
    expect(formatNoteOf([reel, now], now)).toBeUndefined();
    expect(formatNoteOf([left, now, entry('discovery')], now)).toBeUndefined();
  });
});

describe('the note on a library article (D-391)', () => {
  /** A v1 article, as the library serves one: a document with sections and no stops. */
  const articleEntry = (relation: string, title = article.title) =>
    ({
      kind: 'scroll',
      offer: { relation: { kind: relation } },
      context: { variants: [{ kind: 'reel', status: 'ready' }] },
      scroll: { document: { ...article, title } },
    }) as unknown as Parameters<typeof formatNoteOf>[1];

  it('is said when Next lands on an article, from a stage Scroll or from another article, with no calls and no place', () => {
    const now = articleEntry('discovery', 'Why the sky is blue');
    const fromStage = formatNoteOf([entry('discovery'), now], now)!;
    expect(fromStage.title).toBe('Why the sky is blue');
    expect(fromStage.facts).toBe(`${article.kicker} · ${String(article.measures.readingMinutes)} min`);
    expect(fromStage.canSwitchToReel).toBe(true);
    const left = articleEntry('discovery', 'Super-Earth');
    const fromArticle = formatNoteOf([left, now], now)!;
    expect(fromArticle.kept).toEqual({ title: 'Super-Earth', at: undefined, of: undefined });
    expect(keptWords(fromArticle.kept)).toBe('Super-Earth is kept.');
  });

  it('keeps the same limits as for a stage Scroll: not for a Part, a related move, a format switch or a first open', () => {
    const left = entry('discovery');
    expect(formatNoteOf([articleEntry('discovery')], articleEntry('discovery'))).toBeUndefined();
    for (const relation of ['series_step', 'related_move', 'format_variant', 'return']) {
      const other = articleEntry(relation);
      expect(formatNoteOf([left, other], other)).toBeUndefined();
    }
  });
});

describe('the note card', () => {
  const note = formatNoteOf([entry('discovery'), entry('discovery')], entry('discovery'));

  function card(onSwitch = jest.fn(), onUndo = jest.fn(), onExpire = jest.fn(), keys = true) {
    const left = entry('discovery');
    const now = entry('discovery');
    return render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <FormatNoteCard
          note={formatNoteOf([left, now], now) ?? note!}
          onSwitch={onSwitch}
          onUndo={onUndo}
          onExpire={onExpire}
          keys={keys}
        />
      </DisplayProvider>,
    );
  }

  const hidden = { includeHiddenElements: true };

  it('shows the F and Esc chips where the reader has those keys', async () => {
    await card();
    expect(screen.getByText('F', hidden)).toBeTruthy();
    expect(screen.getByText('Esc', hidden)).toBeTruthy();
  });

  it('shows no F or Esc chip on an article, which has no keyed reader, and keeps the buttons (D-391)', async () => {
    await card(jest.fn(), jest.fn(), jest.fn(), false);
    expect(screen.queryByText('F', hidden)).toBeNull();
    expect(screen.queryByText('Esc', hidden)).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch to Reel' })).toBeTruthy();
  });

  it('offers Switch to Reel and Undo, each doing its own move', async () => {
    const onSwitch = jest.fn();
    const onUndo = jest.fn();
    await card(onSwitch, onUndo);
    await fireEvent.press(screen.getByRole('button', { name: 'Switch to Reel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('answers Esc with Undo and F with the Reel from the note itself, and F only where there is a Reel to switch to', async () => {
    const onSwitch = jest.fn();
    const onUndo = jest.fn();
    await card(onSwitch, onUndo);
    const note = screen.getByTestId('format-note');
    await fireEvent(note, 'keyDown', { nativeEvent: { key: 'f' } });
    await fireEvent(note, 'keyDown', { nativeEvent: { key: 'Escape' } });
    await fireEvent(note, 'keyDown', { nativeEvent: { key: 'x' } });
    expect([onSwitch, onUndo].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
  });

  it('does not put itself away while it has focus or the pointer is over it, and starts its time again after', async () => {
    jest.useFakeTimers();
    try {
      const onExpire = jest.fn();
      await card(jest.fn(), jest.fn(), onExpire);
      const note = screen.getByTestId('format-note');
      await fireEvent(note, 'focus');
      jest.advanceTimersByTime(30_000);
      expect(onExpire).not.toHaveBeenCalled();
      await fireEvent(note, 'blur');
      await fireEvent(note, 'pointerEnter');
      jest.advanceTimersByTime(30_000);
      expect(onExpire).not.toHaveBeenCalled();
      await fireEvent(note, 'pointerLeave');
      jest.advanceTimersByTime(8_000);
      expect(onExpire).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_100);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('puts itself away after a few seconds', async () => {
    jest.useFakeTimers();
    try {
      const onExpire = jest.fn();
      await card(jest.fn(), jest.fn(), onExpire);
      expect(onExpire).not.toHaveBeenCalled();
      jest.advanceTimersByTime(9_100);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
