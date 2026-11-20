import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '../../display/display';
import { BeatView, type BeatViewProps } from './beat-view';
import { COOL, WARM } from '../picture';
import type { Beat } from './reading-model';

const beat: Beat = {
  id: 'stop-1',
  kind: 'prose',
  text: [{ kind: 'paragraph', text: 'The planet leans, and that is the whole reason.' }],
  simple: 'The planet is tilted, so we get seasons.',
  notes: [],
};

function shown(overrides: Partial<BeatViewProps> = {}) {
  return (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <BeatView
        beat={beat}
        textVersion={false}
        simpler={false}
        openNotes={new Set()}
        onToggleNote={jest.fn()}
        {...overrides}
      />
    </DisplayProvider>
  );
}

async function show(overrides: Partial<BeatViewProps> = {}) {
  return render(shown(overrides));
}

describe('a beat of the essay (D-429)', () => {
  it('has no "Say it simpler" link under its paragraph, even where the writer gave plainer words', async () => {
    await show();
    expect(screen.getByText('The planet leans, and that is the whole reason.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
    expect(screen.queryByText('Say it simpler')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('simpler-toggle')).not.toBeOnTheScreen();
  });

  it('swaps its words for the plainer ones when the reader switches it, and shows no link then either', async () => {
    await show({ simpler: true });
    expect(screen.getByText('The planet is tilted, so we get seasons.')).toBeOnTheScreen();
    expect(screen.queryByText('The planet leans, and that is the whole reason.')).not.toBeOnTheScreen();
    expect(screen.queryByText('Undo simpler')).not.toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });

  it('says "Plainer words" above the plainer text, in the small label style, and nothing when the words are the writer’s', async () => {
    const view = await show();
    expect(screen.queryByText('Plainer words')).not.toBeOnTheScreen();
    await view.rerender(shown({ simpler: true }));
    const label = screen.getByText('Plainer words');
    expect(label).toBeOnTheScreen();
    // The label is the first thing in the box, above the words.
    const box = screen.getByTestId('simpler-text');
    expect(box.children[0]).toBe(screen.getByTestId('simpler-label'));
    expect(screen.getByText('The planet is tilted, so we get seasons.')).toBeOnTheScreen();
    await view.rerender(shown({ simpler: false }));
    expect(screen.queryByText('Plainer words')).not.toBeOnTheScreen();
  });

  it('announces the change to the plainer words, and back, politely and in a region that was already there', async () => {
    const view = await show();
    const status = screen.getByTestId('simpler-status', { includeHiddenElements: true });
    expect(status).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(status).toHaveProp('role', 'status');
    // Nothing is said until something changes.
    expect(status).toHaveTextContent('');
    await view.rerender(shown({ simpler: true }));
    expect(screen.getByTestId('simpler-status', { includeHiddenElements: true })).toHaveTextContent(
      'Showing this part in plainer words.',
    );
    await view.rerender(shown({ simpler: false }));
    expect(screen.getByTestId('simpler-status', { includeHiddenElements: true })).toHaveTextContent(
      'Showing the writer’s own words again.',
    );
  });

  it('has no announcement where the writer gave no plainer words', async () => {
    const { simple: _simple, ...plain } = beat;
    await show({ beat: plain });
    expect(screen.queryByTestId('simpler-status', { includeHiddenElements: true })).not.toBeOnTheScreen();
  });
});

const linked: Beat = {
  ...beat,
  text: [{ kind: 'paragraph', text: 'The planet leans, and the northern summer comes at the far end of the orbit.' }],
  links: [
    { phrase: 'the planet leans', part: 'tilt', tone: 'warm' },
    { phrase: 'far end', part: 'far', tone: 'cool' },
    { phrase: 'orbit', part: 'orbit', tone: 'mark' },
  ],
};

describe('linked phrases of a beat (document v3)', () => {
  it('draws each phrase that is in the words as a button that names its part, and keeps the words whole', async () => {
    await show({ beat: linked, onLinkPress: jest.fn() });
    expect(screen.getByRole('button', { name: 'Show far end in the picture' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Show orbit in the picture' })).toBeOnTheScreen();
    // "the planet leans" is not in the words as written (capital T), so it is left out rather than failing.
    expect(screen.queryByRole('button', { name: 'Show the planet leans in the picture' })).not.toBeOnTheScreen();
    expect(screen.getByText(/northern summer comes at the/)).toBeOnTheScreen();
  });

  it('calls onLinkPress with the part when a phrase is pressed', async () => {
    const onLinkPress = jest.fn();
    await show({ beat: linked, onLinkPress });
    await fireEvent.press(screen.getByRole('button', { name: 'Show far end in the picture' }));
    expect(onLinkPress).toHaveBeenCalledWith('far');
    await fireEvent.press(screen.getByRole('button', { name: 'Show orbit in the picture' }));
    expect(onLinkPress).toHaveBeenLastCalledWith('orbit');
  });

  it('presses on Enter and on Space, once for a held key', async () => {
    const onLinkPress = jest.fn();
    await show({ beat: linked, onLinkPress });
    const phrase = screen.getByRole('button', { name: 'Show far end in the picture' });
    const key = (name: string, repeat = false) => ({ nativeEvent: { key: name, repeat }, preventDefault: jest.fn() });
    await fireEvent(phrase, 'keyDown', key('Enter'));
    await fireEvent(phrase, 'keyDown', key(' '));
    await fireEvent(phrase, 'keyDown', key(' ', true));
    await fireEvent(phrase, 'keyDown', key('a'));
    expect(onLinkPress).toHaveBeenCalledTimes(2);
  });

  it('underlines a phrase in its part’s colour, the page’s link colour for a mark, and leaves the words in ink', async () => {
    await show({
      beat: { ...linked, text: [{ kind: 'paragraph', text: 'Heat flows to cold, far end, orbit.' }] },
      onLinkPress: jest.fn(),
    });
    const underline = (phrase: string): TextStyle =>
      StyleSheet.flatten(
        screen.getByRole('button', { name: `Show ${phrase} in the picture` }).props.style as StyleProp<TextStyle>,
      ) as TextStyle;
    expect(underline('far end')).toMatchObject({ textDecorationLine: 'underline', textDecorationColor: COOL });
    expect(underline('orbit').textDecorationColor).not.toBe(COOL);
    expect(underline('orbit').textDecorationColor).not.toBe(WARM);
    expect(underline('orbit').color).toBeUndefined();
  });

  it('draws plain words where no one listens for a press', async () => {
    await show({ beat: linked });
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });

  it('shows the plainer words without links', async () => {
    await show({ beat: linked, simpler: true, onLinkPress: jest.fn() });
    expect(screen.getByText('The planet is tilted, so we get seasons.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
});

describe('a quote beat (document v3)', () => {
  const quote: Beat = {
    id: 'q1',
    kind: 'quote',
    cite: { who: 'G. K. Chesterton', work: 'The Thing', year: '1929' },
    text: [{ kind: 'paragraph', text: 'Go away and think.' }],
    simple: 'Think first.',
    links: [],
    notes: [],
  };

  it('sets the quotation in marks and names who said it, where and when under it', async () => {
    await show({ beat: quote });
    expect(screen.getByText('“Go away and think.”')).toBeOnTheScreen();
    expect(screen.getByTestId('quote-cite')).toHaveTextContent('— G. K. Chesterton, The Thing, 1929');
    expect(screen.getByLabelText('Quotation from G. K. Chesterton')).toBeOnTheScreen();
  });

  it('leaves out what the cite does not have', async () => {
    await show({ beat: { ...quote, cite: { who: 'Ada' } } });
    expect(screen.getByTestId('quote-cite')).toHaveTextContent('— Ada');
  });

  it('keeps its linked phrases pressable', async () => {
    const onLinkPress = jest.fn();
    await show({ beat: { ...quote, links: [{ phrase: 'think', part: 'quote' }] }, onLinkPress });
    await fireEvent.press(screen.getByRole('button', { name: 'Show think in the picture' }));
    expect(onLinkPress).toHaveBeenCalledWith('quote');
  });

  it('shows the plainer words instead, as a note that they are not the quotation', async () => {
    await show({ beat: quote, simpler: true });
    expect(screen.getByText('Plainer words')).toBeOnTheScreen();
    expect(screen.queryByTestId('quote-cite')).not.toBeOnTheScreen();
  });
});
