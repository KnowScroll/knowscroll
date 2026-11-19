import { render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '../../display/display';
import { BeatView, type BeatViewProps } from './beat-view';
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
